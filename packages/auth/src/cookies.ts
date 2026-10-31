import type { AuthConfig } from './config.ts';

export interface CookieNames {
  readonly session: string;
  readonly pre: string;
  readonly oauth: string;
  readonly invite: string;
}

// Browsers refuse the __Host- prefix without Secure, so the plain http loopback setup
// gets the bare names.
export function cookieNames(secure: boolean): CookieNames {
  const prefix = secure ? '__Host-' : '';
  return Object.freeze({
    session: `${prefix}drefyn_session`,
    pre: `${prefix}drefyn_pre`,
    oauth: `${prefix}drefyn_oauth`,
    invite: `${prefix}drefyn_invite`,
  });
}

// Auth decides the flags, so a caller can only say which cookie, what value and how long.
export interface CookieSpec {
  readonly name: string;
  readonly value: string;
  readonly maxAgeSeconds: number;
}

// What auth sees of a browser request. No URL, host or header fields: absolute URLs come
// only from the configured origin.
export interface BrowserContext {
  // Already resolved through the trusted hops.
  readonly ip: string;
  readonly userAgent: string;
  readonly cookies: ReadonlyMap<string, string>;
}

// Every value auth writes is a token or a base32 secret, so anything else is a bug that
// would otherwise smuggle a ; into the header.
const VALUE = /^[0-9A-Za-z._-]*$/;

export function serializeCookie(config: AuthConfig, spec: CookieSpec): string {
  const names: readonly string[] = Object.values(config.cookies);
  if (!names.includes(spec.name)) throw new RangeError('not a cookie auth owns');
  if (!VALUE.test(spec.value)) throw new RangeError('cookie value outside the token alphabet');
  if (!Number.isSafeInteger(spec.maxAgeSeconds) || spec.maxAgeSeconds < 0) {
    throw new RangeError('Max-Age must be a whole number of seconds');
  }
  const secure = config.cookieSecure ? '; Secure' : '';
  return `${spec.name}=${spec.value}; Path=/; Max-Age=${String(spec.maxAgeSeconds)}; HttpOnly${secure}; SameSite=Lax`;
}

// Only the name the config chose. With secure cookies on, a bare drefyn_session could have
// been set by any http page on a sibling host, so it is never read.
export function sessionCookieValue(
  config: AuthConfig,
  cookies: ReadonlyMap<string, string>,
): string | undefined {
  return cookies.get(config.cookies.session);
}
