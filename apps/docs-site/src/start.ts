import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAdaptorServer } from '@hono/node-server';
import type { Hono } from 'hono';
import { createApp, type DocsEnv, type DocsSiteDeps } from './app.ts';
import { parseDocsSiteConfig, type Env } from './config.ts';
import { createHostResolver, type SiteDirectory } from './host.ts';
import { createJsonLogger, type DocsLogger } from './log.ts';

// Inside compose's default 10 s stop grace, so requests finish before the kill.
export const DRAIN_MS = 8000;

export interface StartOptions {
  readonly directory: SiteDirectory;
  readonly flags: DocsSiteDeps['flags'];
  readonly logger?: DocsLogger;
  // Defaults to every interface on the configured port.
  readonly listen?: { readonly hostname: string; readonly port: number };
  // Routes that run after host resolution. Page routes arrive with the templates.
  readonly mount?: (app: Hono<DocsEnv>) => void;
}

export interface RunningDocsSite {
  readonly port: number;
  // Stops taking connections and lets requests in flight finish, for at most DRAIN_MS.
  stop(): Promise<void>;
}

function listen(server: Server, port: number, hostname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

// Checks the config before anything listens, so a site base that overlaps the dashboard never
// serves one request.
export async function startDocsSite(env: Env, options: StartOptions): Promise<RunningDocsSite> {
  const config = parseDocsSiteConfig(env);
  const logger = options.logger ?? createJsonLogger();
  const resolver = createHostResolver({
    domains: config.domains,
    directory: options.directory,
    logger,
  });
  const app = createApp({ resolver, flags: options.flags, logger });
  options.mount?.(app);

  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  const where = options.listen ?? { hostname: '0.0.0.0', port: config.port };
  const port = await listen(server, where.port, where.hostname);
  logger.info('site.started', { port });

  let stopping: Promise<void> | undefined;
  return {
    port,
    stop() {
      stopping ??= new Promise<void>((resolve) => {
        const force = setTimeout(() => {
          server.closeAllConnections();
        }, DRAIN_MS);
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
        server.closeIdleConnections();
      });
      return stopping;
    },
  };
}
