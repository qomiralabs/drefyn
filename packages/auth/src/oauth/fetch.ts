import type { OAuthProvider } from '../oauth-types.ts';
import type { AuthLogger } from '../rate-limiter.ts';
import { quietWarn } from '../session-support.ts';

// The only file in auth that may call the global fetch, and only directly. Every OAuth
// token, profile and JWKS request comes through here, to hosts compiled in below; nothing
// from a request or a customer ever reaches the URL. Moves onto guardedFetch once the
// egress package exists: TODO(#166).

export const OAUTH_HOSTS = [
  'github.com',
  'api.github.com',
  'oauth2.googleapis.com',
  'www.googleapis.com',
] as const;

// Each provider reaches only its own hosts, so a bug in one cannot call the other.
const HOSTS: Readonly<Record<OAuthProvider, ReadonlySet<string>>> = {
  github: new Set<string>([OAUTH_HOSTS[0], OAUTH_HOSTS[1]]),
  google: new Set<string>([OAUTH_HOSTS[2], OAUTH_HOSTS[3]]),
};

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const TIMEOUT_MS = 5000;
const MAX_BYTES = 1_048_576;
const NULL_BODY = new Set([101, 204, 205, 304]);

export type OAuthFetchRefusal = 'host' | 'scheme' | 'redirect' | 'timeout' | 'size';

export class OAuthFetchRefused extends Error {
  readonly reason: OAuthFetchRefusal;
  constructor(reason: OAuthFetchRefusal) {
    super(`oauth fetch refused: ${reason}`);
    this.reason = reason;
  }
}

Object.defineProperty(OAuthFetchRefused.prototype, 'name', {
  value: 'OAuthFetchRefused',
  enumerable: false,
});

// Tests only: answers the listed hosts in process, after the checks here have run.
export type OAuthTransport = (url: string, init: RequestInit) => Promise<Response>;

// The request shape openid-client hands its custom fetch, and all this file reads of it.
export interface OAuthRequest {
  readonly method?: string | undefined;
  readonly headers?: Record<string, string> | Headers | undefined;
  readonly body?: RequestInit['body'] | undefined;
  readonly signal?: AbortSignal | null | undefined;
  readonly redirect?: string | undefined;
}

export type OAuthFetch = (url: string, init?: OAuthRequest) => Promise<Response>;

export interface OAuthFetchOptions {
  readonly provider: OAuthProvider;
  readonly logger: AuthLogger;
  readonly transport?: OAuthTransport;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

const TIMED_OUT = Symbol('timed out');

// GitHub answers token errors with HTTP 200 and an error body. As a 400 the library
// raises its documented ResponseBodyError, so one mapper handles every provider.
export function normalizeGitHubTokenError(response: Response, body: Uint8Array): Response {
  if (response.status !== 200) return response;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return response;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return response;
  const fields = parsed as Record<string, unknown>;
  if (typeof fields['error'] !== 'string' || 'access_token' in fields) return response;
  return new Response(body, { status: 400, statusText: 'Bad Request', headers: response.headers });
}

// undici rejects a redirect it was told not to follow with this cause.
function isPlatformRedirect(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    error.cause instanceof Error &&
    error.cause.message === 'unexpected redirect'
  );
}

export function createOAuthFetch(options: OAuthFetchOptions): OAuthFetch {
  const hosts = HOSTS[options.provider];
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const send: OAuthTransport = options.transport ?? ((url, init) => fetch(url, init));

  const refuse = (reason: OAuthFetchRefusal): never => {
    quietWarn(options.logger, 'auth.oauth_fetch_refused', { provider: options.provider, reason });
    throw new OAuthFetchRefused(reason);
  };

  // Reads at most maxBytes, racing every read against the deadline so a stalled body
  // cannot hold the request past it.
  async function read(response: Response, deadline: Promise<never>): Promise<Uint8Array> {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      refuse('size');
    }
    if (response.body === null) return new Uint8Array(0);
    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        refuse('size');
      }
      chunks.push(next.value);
    }
    const body = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      body.set(chunk, at);
      at += chunk.byteLength;
    }
    return body;
  }

  return async (url, init = {}) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return refuse('host');
    }
    if (target.protocol !== 'https:') refuse('scheme');
    if (!hosts.has(target.host) || target.username !== '' || target.password !== '') {
      refuse('host');
    }
    const controller = new AbortController();
    let rejectDeadline: (reason: unknown) => void = () => undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    // Never left unhandled: the race below or the finally always settles it.
    deadline.catch(() => undefined);
    const timer = setTimeout(() => {
      controller.abort(TIMED_OUT);
      rejectDeadline(TIMED_OUT);
    }, timeoutMs);
    const signal =
      init.signal === undefined || init.signal === null
        ? controller.signal
        : AbortSignal.any([init.signal, controller.signal]);
    try {
      // Redirects are never followed: the platform errors on one and any 3xx is refused.
      const request: RequestInit = { redirect: 'error', signal };
      if (init.method !== undefined) request.method = init.method;
      if (init.headers !== undefined) request.headers = init.headers;
      if (init.body !== undefined) request.body = init.body;
      const response = await Promise.race([send(target.href, request), deadline]);
      if ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect') {
        await response.body?.cancel().catch(() => undefined);
        refuse('redirect');
      }
      const body = await read(response, deadline);
      const copy = new Response(NULL_BODY.has(response.status) ? null : body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      return target.href === GITHUB_TOKEN_URL ? normalizeGitHubTokenError(copy, body) : copy;
    } catch (error) {
      if (error instanceof OAuthFetchRefused) throw error;
      if (error === TIMED_OUT || controller.signal.reason === TIMED_OUT) return refuse('timeout');
      if (isPlatformRedirect(error)) return refuse('redirect');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}
