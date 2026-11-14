import type { AuthConfig } from './config.ts';
import type { CookieSpec } from './cookies.ts';
import type { SessionMethod } from './session-support.ts';

// Which way this browser last finished signing in, so the sign in page can mark it. Only the
// method: no address and no account, so the mark says nothing about who used it.
export const LAST_METHODS = ['github', 'google', 'sso', 'email_code', 'password'] as const;
export type LastMethod = (typeof LAST_METHODS)[number];

// The longest lifetime browsers keep, so the mark outlasts a long break.
export const LAST_METHOD_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

const KNOWN: ReadonlySet<string> = new Set(LAST_METHODS);

// Exact values only. Anything else, padded, cased or long, reads as nothing.
export function parseLastMethod(value: unknown): LastMethod | null {
  return typeof value === 'string' && KNOWN.has(value) ? (value as LastMethod) : null;
}

// A CLI link is not a way in that the page offers, so it leaves the mark as it was.
const FROM_SESSION: Readonly<Record<SessionMethod, LastMethod | null>> = {
  email: 'email_code',
  password: 'password',
  github: 'github',
  google: 'google',
  cli_link: null,
};

// Takes the finished session, so nothing short of a full sign in can write it.
export function lastMethodCookie(
  config: AuthConfig,
  session: { readonly method: SessionMethod } | undefined,
): readonly CookieSpec[] {
  const method = session === undefined ? null : FROM_SESSION[session.method];
  if (method === null) return [];
  return [
    { name: config.cookies.lastMethod, value: method, maxAgeSeconds: LAST_METHOD_MAX_AGE_SECONDS },
  ];
}
