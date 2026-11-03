import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
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

// Origin form only. An absolute form target overrides the Host header, so the Host check
// would pass while Next builds its URLs from the target; // and /\ read as a host to browsers.
const ORIGIN_FORM = /^\/(?![/\\])/;
const badTarget = (req: IncomingMessage) => !ORIGIN_FORM.test(req.url ?? '');

interface Refusal {
  readonly status: number;
  readonly phrase: string;
  readonly body: string;
}

const BAD_REQUEST: Refusal = { status: 400, phrase: 'Bad Request', body: 'bad request\n' };
const MISDIRECTED: Refusal = {
  status: 421,
  phrase: 'Misdirected Request',
  body: 'misdirected request\n',
};
const FAILED: Refusal = { status: 500, phrase: 'Internal Server Error', body: 'internal error\n' };

// Every check a request or an upgrade passes before Next, and the header rewrite. Null means
// it may go on.
function createAdmission(config: WrapperConfig, warn: Warn, now: () => number) {
  const forwardedWarning = createThrottle(now);
  const chainWarning = createThrottle(now);

  return (req: IncomingMessage): Refusal | null => {
    if (badTarget(req)) return BAD_REQUEST;
    // Next builds its action check and absolute URLs from the Host, so a request for any
    // other name never reaches it.
    if (!hostMatches(req.headers.host, config)) return MISDIRECTED;
    const socket = req.socket.remoteAddress;
    if (socket === undefined) return BAD_REQUEST;
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
    return null;
  };
}

export function createWrapper(deps: WrapperDeps) {
  const { config, handle } = deps;
  const warn = deps.warn ?? logWarn;
  const admit = createAdmission(config, warn, deps.now ?? Date.now);

  return (req: IncomingMessage, res: ServerResponse): void => {
    if (!badTarget(req) && isLoopbackHost(req.headers.host) && pathOf(req.url) === HEALTH_PATH) {
      reply(res, 200, 'ok\n');
      return;
    }
    const refusal = admit(req);
    if (refusal !== null) {
      reply(res, refusal.status, refusal.body);
      return;
    }
    Promise.resolve()
      .then(() => handle(req, res))
      .catch(() => {
        // Next answers its own errors; this only catches a handler that threw past them.
        warn('dashboard.request_failed', {});
        if (!res.headersSent) reply(res, 500, 'internal error\n');
      });
  };
}

export interface UpgradeWrapperDeps {
  readonly config: WrapperConfig;
  readonly upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => unknown;
  readonly warn?: Warn;
  readonly now?: () => number;
  // How many upgrade listeners the server has; anything but this one skips every check.
  readonly listeners?: () => number;
}

// There is no response object on an upgrade, so a refusal is written to the socket by hand.
function refuseUpgrade(socket: Duplex, refusal: Refusal): void {
  const length = Buffer.byteLength(refusal.body);
  socket.end(
    `HTTP/1.1 ${String(refusal.status)} ${refusal.phrase}\r\nconnection: close\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${String(length)}\r\n\r\n${refusal.body}`,
  );
}

// Upgrades skip the request listener, so they get the same checks here. server.ts keeps
// Next's own listener off the server; a second listener is logged, because it would see
// requests these checks refused.
export function createUpgradeWrapper(deps: UpgradeWrapperDeps) {
  const { config, upgrade } = deps;
  const warn = deps.warn ?? logWarn;
  const admit = createAdmission(config, warn, deps.now ?? Date.now);

  return (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // Node leaves an upgrade socket with no error listener, and an unhandled reset would end
    // the process.
    socket.on('error', () => {
      socket.destroy();
    });
    const listeners = deps.listeners?.() ?? 1;
    if (listeners !== 1) warn('dashboard.upgrade_listener_extra', { listeners });
    const refusal = admit(req);
    if (refusal !== null) {
      refuseUpgrade(socket, refusal);
      return;
    }
    Promise.resolve()
      .then(() => upgrade(req, socket, head))
      .catch(() => {
        warn('dashboard.request_failed', {});
        refuseUpgrade(socket, FAILED);
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
