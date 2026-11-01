import { expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  createEmailSignIn,
  createSessions,
  parseAuthConfig,
  parseVerifyFragment,
  type AuthConfig,
  type BrowserContext,
  type CookieSpec,
  type EmailSignInDeps,
} from '../../../src/index.ts';
import { createTestAuthMailer, type TestAuthMailer } from '../../../src/testing.ts';
import { validEnv } from '../../support.ts';
import type { Harness } from './harness.ts';

// Limits wide enough that only the test that is about a limit ever meets one.
export const ROOMY_LIMITS = {
  DREFYN_AUTH_RATE_EMAIL_SEND: '1000/10m',
  DREFYN_AUTH_RATE_EMAIL_SEND_IP: '1000/10m',
  DREFYN_AUTH_RATE_EMAIL_SEND_ADDRESS_CEILING: '1000/1d',
  DREFYN_AUTH_RATE_CODE_VERIFY: '1000/1h',
} as const;

export function configWith(env: Readonly<Record<string, string>> = {}): AuthConfig {
  return parseAuthConfig({
    ...validEnv(randomBytes(32).toString('base64url')),
    ...ROOMY_LIMITS,
    ...env,
  });
}

// The config is frozen all the way down, so a spy on the compare needs its own keys object
// that calls through to the real one.
export function withCompareSpy(config: AuthConfig) {
  const { keys } = config;
  const compare = vi.fn((...args: Parameters<typeof keys.verify>) => keys.verify(...args));
  return { config: { ...config, keys: { ...config.keys, verify: compare } }, compare };
}

export interface Flow {
  readonly config: AuthConfig;
  readonly mail: TestAuthMailer;
  readonly signIn: ReturnType<typeof createEmailSignIn>;
  readonly sessions: ReturnType<typeof createSessions>;
}

export function flowFor(
  h: Harness,
  config: AuthConfig,
  extra: Partial<EmailSignInDeps> = {},
  mail: TestAuthMailer = createTestAuthMailer(),
): Flow {
  const logger = {
    info(event: string, fields: Readonly<Record<string, string | number | boolean>>) {
      h.logs.push({ level: 'info', event, fields });
    },
    warn(event: string, fields: Readonly<Record<string, string | number | boolean>>) {
      h.logs.push({ level: 'warn', event, fields });
    },
  };
  const sessions = createSessions(config, {
    db: h.db,
    authDb: h.authDb,
    logger,
    mailer: mail.mailer,
  });
  const signIn = createEmailSignIn(config, {
    db: h.db,
    authDb: h.authDb,
    logger,
    mailer: mail.mailer,
    sessions,
    ...extra,
  });
  return { config, mail, signIn, sessions };
}

let counter = 0;

// A browser with its own address, cookie jar and user agent. apply() takes Set-Cookie the way
// a browser would: a zero Max-Age deletes.
export function newBrowser(ip = `198.51.100.${String((counter += 1) % 250)}`) {
  const cookies = new Map<string, string>();
  return {
    cookies,
    context(overrides: Partial<BrowserContext> = {}): BrowserContext {
      return { ip, userAgent: 'Integration/1.0', cookies: new Map(cookies), ...overrides };
    },
    apply(setCookies: readonly CookieSpec[]) {
      for (const c of setCookies) {
        if (c.maxAgeSeconds === 0) cookies.delete(c.name);
        else cookies.set(c.name, c.value);
      }
    },
  };
}

export type Browser = ReturnType<typeof newBrowser>;

// Starts a sign in from a browser, runs the deferred send, and returns what the mail said.
export async function requestCode(flow: Flow, browser: Browser, email: string) {
  const before = flow.mail.sent.length;
  const result = await flow.signIn.startEmailSignIn(browser.context(), { email });
  if (!result.ok) throw result.error;
  browser.apply(result.value.setCookies);
  await result.value.send();
  const sent = flow.mail.sent.slice(before).find((m) => m.to === email);
  if (sent === undefined) return null;
  const fragment = parseVerifyFragment(sent.link.hash.slice(1));
  if (fragment === null) throw new Error('the mail link has no fragment');
  return {
    code: sent.code,
    challenge: sent.link.hash.slice(1, 27),
    challengeId: fragment.challengeId,
  };
}

export const wrongCode = (code: string) =>
  String((Number(code) + 1) % 100_000_000).padStart(8, '0');

// Rate windows are aligned to the database clock (10 minutes, an hour, a day). A test that
// counts against a limit waits until it can finish inside one of each, so a window edge in
// the middle never resets a count it relies on.
export async function insideOneWindow(h: Harness, budgetSeconds: number): Promise<void> {
  const left = Number(
    await h.sql(
      `select least(600 - mod(e, 600), 3600 - mod(e, 3600), 86400 - mod(e, 86400)) from (select floor(extract(epoch from now()))::bigint as e) t;`,
    ),
  );
  if (left > budgetSeconds) return;
  await new Promise((resolve) => setTimeout(resolve, (left + 1) * 1000));
}

export interface Wire {
  readonly ok: boolean;
  readonly shape: string;
  readonly retryAfterSeconds: number | null;
}

// What the browser sees, with a new random cookie value reduced to its length. Retry-After
// comes from the window clock, not the address, so it is kept apart and compared to the
// second.
export function wireOf(
  result:
    | { readonly ok: true; readonly value: { readonly setCookies: readonly CookieSpec[] } }
    | {
        readonly ok: false;
        readonly error: {
          readonly code: string;
          readonly message: string;
          readonly retryAfterSeconds?: number;
        };
      },
): Wire {
  if (!result.ok) {
    return {
      ok: false,
      shape: JSON.stringify({ code: result.error.code, message: result.error.message }),
      retryAfterSeconds: result.error.retryAfterSeconds ?? null,
    };
  }
  const { setCookies, ...rest } = result.value;
  return {
    ok: true,
    shape: JSON.stringify({
      keys: Object.keys(rest).sort(),
      cookies: setCookies.map((c) => [c.name, c.maxAgeSeconds, c.value.length]),
    }),
    retryAfterSeconds: null,
  };
}

export function expectSameWire(a: Wire, b: Wire): void {
  expect(a.shape).toBe(b.shape);
  expect(a.retryAfterSeconds === null).toBe(b.retryAfterSeconds === null);
  if (a.retryAfterSeconds !== null && b.retryAfterSeconds !== null) {
    expect(Math.abs(a.retryAfterSeconds - b.retryAfterSeconds)).toBeLessThanOrEqual(1);
  }
}
