import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  FORWARDING_HEADERS,
  THREAD_POOL_WANTED,
  createThrottle,
  hostMatches,
  isLoopbackHost,
  parseWrapperConfig,
  resolveClientAddress,
  rewriteHeaders,
  smallThreadPool,
  type Env,
  type WrapperConfig,
} from './client-ip.ts';
import { logWarn, type LogContext } from './log.ts';

// What runs before Next's handler on every request: the health check, the Host check and
// the header rewrite. server.ts wires it to the HTTP server; tests call it directly.

// Answered by the wrapper itself, only on a loopback Host, so a container health check
// never depends on the public origin resolving.
export const HEALTH_PATH = '/healthz';

export type Warn = (event: string, context: LogContext) => void;

export interface WrapperDeps {
  readonly config: WrapperConfig;
  readonly handle: (req: IncomingMessage, res: ServerResponse) => unknown;
  readonly warn?: Warn;
  readonly now?: () => number;
}

function reply(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

const pathOf = (url: string | undefined) => (url ?? '').split('?')[0];

export function createWrapper(deps: WrapperDeps) {
  const { config, handle } = deps;
  const warn = deps.warn ?? logWarn;
  const now = deps.now ?? Date.now;
  const forwardedWarning = createThrottle(now);
  const chainWarning = createThrottle(now);

  return (req: IncomingMessage, res: ServerResponse): void => {
    const host = req.headers.host;
    if (isLoopbackHost(host) && pathOf(req.url) === HEALTH_PATH) {
      reply(res, 200, 'ok\n');
      return;
    }
    // Next builds its action check and absolute URLs from the Host, so a request for any
    // other name never reaches it.
    if (!hostMatches(host, config)) {
      reply(res, 421, 'misdirected request\n');
      return;
    }
    const socket = req.socket.remoteAddress;
    if (socket === undefined) {
      reply(res, 400, 'bad request\n');
      return;
    }
    const headers = req.headers;
    if (config.hops === 0 && FORWARDING_HEADERS.some((name) => headers[name] !== undefined)) {
      // How a self hoster finds a proxy they forgot to declare.
      if (forwardedWarning()) warn('auth.forwarded_header_ignored', { hops: 0 });
    }
    const forwarded = headers['x-forwarded-for'];
    const viewer = headers['cloudfront-viewer-address'];
    const resolved = resolveClientAddress(
      {
        socket,
        forwardedFor: Array.isArray(forwarded) ? forwarded.join(', ') : forwarded,
        viewer: Array.isArray(viewer) ? viewer.join(', ') : viewer,
      },
      config,
    );
    if (resolved.chainInvalid && chainWarning()) {
      warn('auth.client_ip_chain_invalid', { hops: config.hops });
    }
    rewriteHeaders(headers, config, resolved.address);
    Promise.resolve()
      .then(() => handle(req, res))
      .catch(() => {
        // Next answers its own errors; this only catches a handler that threw past them.
        warn('dashboard.request_failed', {});
        if (!res.headersSent) reply(res, 500, 'internal error\n');
      });
  };
}

// Startup: refuses bad settings by throwing, and reports a thread pool too small for
// password hashing once. It never sets UV_THREADPOOL_SIZE; libuv has already read it.
export function startWrapper(env: Env, warn: Warn = logWarn): WrapperConfig {
  const config = parseWrapperConfig(env);
  const value = smallThreadPool(env);
  if (value !== null) warn('auth.threadpool_small', { value, wanted: THREAD_POOL_WANTED });
  return config;
}
