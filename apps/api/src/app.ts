import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { ApiKeyFailureLimiter, ApiKeyVerifier } from '@drefyn/auth';
import { pingDatabase, type Database, type PublishedDatabase } from '@drefyn/db';
import type { FlagClient } from '@drefyn/flags';
import { Hono, type Context, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { routePath } from 'hono/route';
import { resolveClientAddress, parseIp, type TrustedHops } from './client-ip.ts';
import { ApiError, errorResponse } from './errors.ts';
import type { ApiLogger, LogFields } from './log.ts';

export interface ApiDeps {
  // drefyn_app: key checks, the failure limiter and project lookups.
  readonly db: Database;
  // drefyn_public_reader: public reads only. Never stands in for db, nor db for it.
  readonly published: PublishedDatabase;
  readonly keys: ApiKeyVerifier;
  // Failed scope and project checks count against the same client as failed keys.
  readonly failures: ApiKeyFailureLimiter;
  readonly flags: FlagClient;
  readonly logger: ApiLogger;
  readonly config: TrustedHops & { readonly maxBodyBytes: number };
}

// Set by the guard once the key is proved, and read by the request log.
export interface ProvedIds {
  readonly organizationId: string;
  readonly projectId: string;
  readonly keyId: string;
}

export interface ApiEnv {
  Bindings: { readonly incoming?: IncomingMessage };
  Variables: {
    clientIp: string;
    proved: ProvedIds;
  };
}

// The longest /readyz waits on each pool. A load balancer probe gives up soon after.
export const READY_TIMEOUT_MS = 1000;

const STATUS_HEADERS = { 'cache-control': 'no-store' } as const;
const PROBES: ReadonlySet<string> = new Set(['/healthz', '/readyz']);

function clientAddress(c: Context<ApiEnv>, config: TrustedHops, logger: ApiLogger): string {
  const socket = parseIp(c.env.incoming?.socket.remoteAddress ?? '');
  // A socket torn down before the request was read has no address left to count against.
  if (socket === null) throw new ApiError('api.unavailable');
  const resolved = resolveClientAddress(
    {
      socket,
      forwardedFor: c.req.header('x-forwarded-for'),
      viewer: c.req.header('cloudfront-viewer-address'),
    },
    config,
  );
  if (resolved.chainInvalid) logger.warn('api.client_ip_chain_invalid', { hops: config.hops });
  return resolved.address;
}

// No listening here, so tests call it directly. Routes under /v1 attach to the returned app
// behind guard(); nothing else in it reads tenant data.
export function createApp(deps: ApiDeps): Hono<ApiEnv> {
  const { logger, config } = deps;
  const app = new Hono<ApiEnv>();

  app.use('*', async (c: Context<ApiEnv>, next: Next) => {
    const started = performance.now();
    const requestId = randomUUID();
    try {
      await next();
    } finally {
      c.header('x-request-id', requestId);
      c.header('x-content-type-options', 'nosniff');
      const route = routePath(c, -1);
      // Probes come every few seconds; a line for each passing one would bury the rest.
      const quietProbe = PROBES.has(route) && c.res.ok;
      if (!quietProbe) {
        const proved = c.get('proved') as ProvedIds | undefined;
        const fields: LogFields = {
          requestId,
          method: c.req.method,
          // The route pattern, never the path: a path can carry a query string with a key in it.
          route,
          status: c.res.status,
          durationMs: Math.round(performance.now() - started),
          ...proved,
        };
        logger.info('api.request', fields);
      }
    }
  });

  app.use('*', async (c: Context<ApiEnv>, next: Next) => {
    c.set('clientIp', clientAddress(c, config, logger));
    await next();
  });

  app.use(
    '*',
    bodyLimit({
      maxSize: config.maxBodyBytes,
      onError: () => errorResponse(new ApiError('api.too_large')),
    }),
  );

  // Process up. Touches nothing, so a database outage never restarts a healthy process.
  app.get('/healthz', (c) => c.json({ status: 'ok' }, 200, STATUS_HEADERS));

  // Both pools answer. Fails on either, so a load balancer stops sending traffic this process
  // cannot serve, rather than letting public reads fall back to the app role.
  app.get('/readyz', async (c) => {
    const [app_, reader] = await Promise.allSettled([
      pingDatabase(deps.db, READY_TIMEOUT_MS),
      pingDatabase(deps.published, READY_TIMEOUT_MS),
    ]);
    if (app_.status === 'fulfilled' && reader.status === 'fulfilled') {
      return c.json({ status: 'ready' }, 200, STATUS_HEADERS);
    }
    logger.warn('api.not_ready', {
      app: app_.status === 'fulfilled',
      reader: reader.status === 'fulfilled',
    });
    return errorResponse(new ApiError('api.unavailable'));
  });

  app.notFound(() => errorResponse(new ApiError('api.not_found')));

  app.onError((error) => {
    if (error instanceof ApiError) return errorResponse(error);
    // The name only: a message can carry whatever the failure underneath was holding.
    logger.error('api.unhandled_error', { error: error.name });
    return errorResponse(new ApiError('api.internal'));
  });

  return app;
}
