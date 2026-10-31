import { vi } from 'vitest';
import {
  AuthError,
  encodeSecret,
  sha256,
  type AuthLogger,
  type BrowserContext,
  type RateLimiter,
  type SessionInfo,
} from '../src/index.ts';
import { createTestAuthMailer } from '../src/testing.ts';
import { scriptedStore, type Responder, type Statement } from './scripted-store.ts';
import { AUTHENTICATED_AT, EXPIRES_AT, SESSION, USER, config } from './session-fixtures.ts';

export { config, USER };

export const ADDRESS = 'person@example.com';
export const IP = '203.0.113.9';
export const PRE = Buffer.alloc(32, 4);
export const PRE_COOKIE = encodeSecret(PRE);
export const CHALLENGE = '01890a5d-ac96-774b-bcce-b302099a8070';

export const browser = (pre: string | null = PRE_COOKIE): BrowserContext => ({
  ip: IP,
  userAgent: 'Unit/1.0',
  cookies: new Map(pre === null ? [] : [[config.cookies.pre, pre]]),
});

export const session: SessionInfo = {
  sessionId: SESSION,
  userId: USER,
  email: ADDRESS,
  authenticatedAt: AUTHENTICATED_AT,
  expiresAt: EXPIRES_AT,
  method: 'email',
};

export const on = (s: Statement, verb: string, table: string) =>
  new RegExp(`^\\s*${verb}\\b`, 'i').test(s.sql) && s.sql.includes(`"${table}"`);

export interface ChallengeShape {
  readonly codeHmac?: Buffer;
  readonly browserHash?: Buffer;
  readonly purpose?: string;
  readonly userId?: string | null;
  readonly live?: boolean;
}

// Every column and alias a challenge read or the guarded update may return, so the
// responder does not care which subset the code selects.
export function challengeRow(shape: ChallengeShape = {}): Record<string, unknown> {
  return {
    id: CHALLENGE,
    email_normalized: ADDRESS,
    purpose: shape.purpose ?? 'sign_in',
    user_id: shape.userId === undefined ? USER : shape.userId,
    code_hmac: shape.codeHmac ?? Buffer.alloc(32),
    browser_hash: shape.browserHash ?? sha256(PRE),
    attempts: 1,
    return_to: '/',
    pending_provider: null,
    pending_subject: null,
    live: shape.live ?? true,
  };
}

export function emailResponder(
  options: {
    readonly known?: boolean;
    readonly challenge?: Record<string, unknown> | null;
  } = {},
): Responder {
  return (s) => {
    if (on(s, 'select', 'users')) return options.known === false ? [] : [{ id: USER }];
    if (on(s, 'select', 'email_challenges') || on(s, 'update', 'email_challenges')) {
      return options.challenge === null || options.challenge === undefined
        ? []
        : [options.challenge];
    }
    return [];
  };
}

export function fakeLimiter(refuse?: (bucket: string) => boolean): RateLimiter {
  return {
    keyFor: (bucket, value) => config.keys.mac('rate', [bucket, ...value]),
    reserve: vi.fn((bucket: string) =>
      refuse?.(bucket) === true
        ? Promise.reject(new AuthError('AUTH_RATE_LIMITED', { retryAfterSeconds: 60 }))
        : Promise.resolve(),
    ),
  };
}

export function recordingLogger() {
  const logs: { event: string; fields: Readonly<Record<string, unknown>> }[] = [];
  const logger: AuthLogger = {
    warn(event, fields) {
      logs.push({ event, fields });
    },
  };
  return { logger, logs };
}

export const fakeSessions = () => ({
  startSession: vi.fn(() =>
    Promise.resolve({
      session,
      setCookies: [{ name: config.cookies.session, value: 'v1.x', maxAgeSeconds: 60 }],
    }),
  ),
});

export function unitDeps(responder: Responder = emailResponder()) {
  const scripted = scriptedStore(responder);
  const { logger, logs } = recordingLogger();
  const mail = createTestAuthMailer();
  const sessions = fakeSessions();
  const limiter = fakeLimiter();
  return {
    scripted,
    logs,
    mail,
    sessions,
    limiter,
    deps: { store: scripted.store, logger, mailer: mail.mailer, sessions, limiter },
  };
}
