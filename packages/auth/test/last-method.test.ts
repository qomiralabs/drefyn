import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  LAST_METHODS,
  LAST_METHOD_MAX_AGE_SECONDS,
  lastMethodCookie,
  parseAuthConfig,
  parseLastMethod,
  serializeCookie,
  type SessionMethod,
} from '../src/index.ts';
import { base64url, validEnv } from './support.ts';

const SECRET = base64url(new Uint8Array(32).fill(7));
const secure = parseAuthConfig(validEnv(SECRET));
const plain = parseAuthConfig({
  ...validEnv(SECRET),
  DREFYN_APP_ORIGIN: 'http://127.0.0.1:3000',
  DREFYN_AUTH_COOKIE_SECURE: 'false',
});

describe('parseLastMethod', () => {
  it('accepts exactly the five methods', () => {
    expect(LAST_METHODS).toEqual(['github', 'google', 'sso', 'email_code', 'password']);
    for (const method of LAST_METHODS) expect(parseLastMethod(method)).toBe(method);
  });

  it.each([
    undefined,
    null,
    42,
    '',
    'GitHub',
    'GITHUB',
    ' github',
    'github ',
    'email',
    'cli_link',
    'password'.repeat(100),
    'github;admin',
  ])('reads %j as nothing', (value) => {
    expect(parseLastMethod(value)).toBeNull();
  });

  it('reads any other string as nothing', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 4096 }).filter((value) => !LAST_METHODS.some((m) => m === value)),
        (value) => parseLastMethod(value) === null,
      ),
      { numRuns: 2000 },
    );
  });
});

describe('lastMethodCookie', () => {
  const session = (method: SessionMethod) => ({ method });

  it('maps each finished sign in to the method people pick on the page', () => {
    expect(lastMethodCookie(secure, session('email'))).toEqual([
      { name: '__Host-drefyn_last_method', value: 'email_code', maxAgeSeconds: 34_560_000 },
    ]);
    expect(lastMethodCookie(secure, session('password'))[0]?.value).toBe('password');
    expect(lastMethodCookie(secure, session('github'))[0]?.value).toBe('github');
    expect(lastMethodCookie(secure, session('google'))[0]?.value).toBe('google');
  });

  it('writes nothing for a CLI link or a sign in without a session', () => {
    expect(lastMethodCookie(secure, session('cli_link'))).toEqual([]);
    expect(lastMethodCookie(secure, undefined)).toEqual([]);
  });

  it('lasts 400 days', () => {
    expect(LAST_METHOD_MAX_AGE_SECONDS).toBe(400 * 24 * 60 * 60);
  });

  it('serializes HttpOnly and Lax, Secure only with secure cookies on', () => {
    const [onSecure] = lastMethodCookie(secure, session('github'));
    const [onPlain] = lastMethodCookie(plain, session('github'));
    if (onSecure === undefined || onPlain === undefined) throw new Error('no cookie');
    expect(serializeCookie(secure, onSecure)).toBe(
      '__Host-drefyn_last_method=github; Path=/; Max-Age=34560000; HttpOnly; Secure; SameSite=Lax',
    );
    expect(serializeCookie(plain, onPlain)).toBe(
      'drefyn_last_method=github; Path=/; Max-Age=34560000; HttpOnly; SameSite=Lax',
    );
  });
});

// The value says how someone signs in, so it never sits in a log line next to who they are.
describe('logging', () => {
  it('the cookie code logs nothing', () => {
    const source = readFileSync(new URL('../src/last-method.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\b(console|log[A-Z]\w*|quietWarn|logger)\b/);
  });
});
