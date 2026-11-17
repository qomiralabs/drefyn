import type { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  AuthError,
  createApiKeyFailureLimiter,
  createApiKeyVerifier,
  parseApiAuthConfig,
} from '@drefyn/auth';
import {
  closeDatabase,
  createDatabase,
  createPublishedDatabase,
  DbError,
  parseDatabaseConfig,
  parsePublishedReaderConfig,
  type Database,
  type PublishedDatabase,
} from '@drefyn/db';
import {
  createFlagClient,
  FlagError,
  loadFlagConfig,
  type FlagClient,
  type FlagConfig,
} from '@drefyn/flags';
import {
  createRetrieval,
  parseRetrievalConfig,
  publishedReader,
  RetrievalConfigError,
} from '@drefyn/retrieval';
import { createAdaptorServer } from '@hono/node-server';
import type { Hono } from 'hono';
import { createApp, type ApiDeps, type ApiEnv } from './app.ts';
import { ApiConfigError, parseApiConfig, type Env } from './config.ts';
import { createJsonLogger, type ApiLogger, type LogFields } from './log.ts';
import { appMcpStore, mountMcp } from './mcp.ts';

// Inside compose's default 10 s stop grace, so requests finish before the kill.
export const DRAIN_MS = 8000;

export interface StartOptions {
  readonly logger?: ApiLogger;
  readonly drainMs?: number;
  // Seams for tests. Production passes none of these.
  readonly openDatabase?: (env: Env, logger: ApiLogger) => Promise<Database>;
  readonly openPublished?: (env: Env, logger: ApiLogger) => Promise<PublishedDatabase>;
  readonly flags?: FlagClient;
  readonly mount?: (app: Hono<ApiEnv>, deps: ApiDeps) => void;
}

export interface RunningApi {
  readonly port: number;
  // Stops taking connections, lets requests in flight finish, then closes the pools.
  stop(): Promise<void>;
}

const openApp = (env: Env, logger: ApiLogger) =>
  createDatabase(parseDatabaseConfig(env), { logger });

const openReader = (env: Env, logger: ApiLogger) =>
  createPublishedDatabase(parsePublishedReaderConfig(env), { logger });

// Built on first use and dropped when it fails to start, so a flag source that was down at
// boot does not keep every flag off until a restart. Any failure answers off.
export function lazyFlagClient(config: FlagConfig, logger: ApiLogger): FlagClient {
  let client: Promise<FlagClient> | undefined;
  const get = () => {
    client ??= createFlagClient(config, {
      // Release flags only; plan limits go through entitlements in the guard.
      entitlements: { hasFeature: () => Promise.resolve(false) },
      logger: {
        warn: (event, fields) => {
          logger.warn(event, fields);
        },
      },
    }).catch((error: unknown) => {
      client = undefined;
      throw error;
    });
    return client;
  };
  return Object.freeze({
    isOn: async (name, ctx) => (await get()).isOn(name, ctx),
    evaluate: async (name, ctx) => (await get()).evaluate(name, ctx),
    close: async () => {
      const started = client;
      client = undefined;
      if (started !== undefined) await (await started.catch(() => null))?.close();
    },
  } satisfies FlagClient);
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => {
      reject(error);
    };
    server.once('error', failed);
    server.listen(port, host, () => {
      server.off('error', failed);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

export async function startApi(env: Env, options: StartOptions = {}): Promise<RunningApi> {
  const logger = options.logger ?? createJsonLogger();
  const config = parseApiConfig(env);
  // Refuses the auth database URL and every auth secret before anything connects.
  const authConfig = parseApiAuthConfig(env);
  const flagConfig = loadFlagConfig(env);
  const retrievalConfig = parseRetrievalConfig(env);

  const db = await (options.openDatabase ?? openApp)(env, logger);
  let published: PublishedDatabase;
  try {
    published = await (options.openPublished ?? openReader)(env, logger);
  } catch (error) {
    await closeDatabase(db);
    throw error;
  }
  const failures = createApiKeyFailureLimiter({ db, config: authConfig });
  const keys = createApiKeyVerifier(env, { db, limiter: failures, logger });
  const flags = options.flags ?? lazyFlagClient(flagConfig, logger);
  const deps: ApiDeps = {
    db,
    published,
    keys,
    failures,
    flags,
    logger,
    config: {
      hops: config.hops,
      viewerHeader: config.viewerHeader,
      maxBodyBytes: config.maxBodyBytes,
    },
  };
  const app = createApp(deps);
  // Behind mcp.v1 and the mcp.serve kill switch; content reads behind retrieval.v1 as well.
  mountMcp(app, deps, {
    retrieval: createRetrieval({
      reader: publishedReader(published),
      config: retrievalConfig,
      flags: { evaluate: (name, ctx) => flags.evaluate(name, ctx) },
      logger: {
        info: (event, fields) => {
          logger.info(event, fields);
        },
        warn: (event, fields) => {
          logger.warn(event, fields);
        },
      },
    }),
    store: appMcpStore(db),
    config: { maxBodyBytes: config.mcpMaxBodyBytes, host: config.mcpHost },
  });
  options.mount?.(app, deps);

  // Global Request and Response stay Node's own, so nothing else in the process sees a swap.
  const server = createAdaptorServer({ fetch: app.fetch, overrideGlobalObjects: false }) as Server;
  let port: number;
  try {
    port = await listen(server, config.port, config.host);
  } catch (error) {
    await Promise.allSettled([closeDatabase(db), closeDatabase(published), flags.close()]);
    throw error;
  }
  logger.info('api.listening', { port });

  const drainMs = options.drainMs ?? DRAIN_MS;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      logger.info('api.stopping', { drainMs });
      // Past the drain, whatever is still open is cut so the pools can close.
      const cut = setTimeout(() => {
        server.closeAllConnections();
      }, drainMs);
      // A keep alive socket goes idle once its last response is sent, and would then hold close
      // open until it timed out, so idle ones are closed as they appear.
      const sweep = setInterval(() => {
        server.closeIdleConnections();
      }, 50);
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeIdleConnections();
      });
      clearTimeout(cut);
      clearInterval(sweep);
      await Promise.allSettled([closeDatabase(db), closeDatabase(published), flags.close()]);
      logger.info('api.stopped', {});
    })();
    return stopping;
  };
  return { port, stop };
}

// SIGTERM from compose or ECS, SIGINT from a terminal: both drain, then exit 0.
export function stopOnSignals(
  running: RunningApi,
  exit: (code: number) => void,
  target: EventEmitter = process,
): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    target.once(signal, () => {
      void running.stop().then(() => {
        exit(0);
      });
    });
  }
}

// What a failed start leaves in the log: the error's kind, its code and the key it names. The
// errors listed here carry fixed text; anything else gives its name only.
export function describeStartFailure(error: unknown): LogFields {
  if (error instanceof ApiConfigError) {
    return { error: error.name, key: error.key, reason: error.message };
  }
  if (error instanceof AuthError) {
    return {
      error: error.name,
      code: error.code,
      ...(error.key === undefined ? {} : { key: error.key }),
    };
  }
  if (error instanceof DbError)
    return { error: error.name, code: error.code, reason: error.message };
  if (error instanceof RetrievalConfigError) {
    return { error: error.name, code: error.code, key: error.key };
  }
  if (error instanceof FlagError) {
    return {
      error: error.name,
      code: error.code,
      ...(error.key === undefined ? {} : { key: error.key }),
    };
  }
  return { error: error instanceof Error ? error.name : typeof error };
}
