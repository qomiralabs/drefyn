import { createHash } from 'node:crypto';
import type { AuthDatabase, Database } from '@drefyn/db';
import { idOf, userId as toUserId, type UserId } from '@drefyn/tenancy';
import {
  createSessions,
  formatSessionToken,
  parseAuthConfig,
  type AuthConfig,
  type AuthLogger,
  type BrowserContext,
  type RateLimiter,
  type SessionId,
  type SessionInfo,
  type SessionsDeps,
} from '../src/index.ts';
import { scriptedStore, type Responder, type Statement } from './scripted-store.ts';
import { UUID_A, UUID_B, validEnv } from './support.ts';

export const config: AuthConfig = parseAuthConfig(validEnv());
export const loopbackConfig: AuthConfig = parseAuthConfig({
  ...validEnv(),
  DREFYN_APP_ORIGIN: 'http://localhost:3000',
  DREFYN_AUTH_COOKIE_SECURE: 'false',
});

export const USER: UserId = toUserId(UUID_A);
export const OTHER_USER: UserId = toUserId(UUID_B);
export const SESSION: SessionId = idOf('ses', '01890a5d-ac96-774b-bcce-b302099a8060');
export const OTHER_SESSION: SessionId = idOf('ses', '01890a5d-ac96-774b-bcce-b302099a8061');
export const SECRET = Buffer.alloc(32, 9);

export const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest();

export function tokenFor(
  user: UserId = USER,
  session: SessionId = SESSION,
  secret: Uint8Array = SECRET,
): string {
  return formatSessionToken({ userId: user, sessionId: session, secret });
}

export interface RowShape {
  readonly id?: string;
  readonly user_id?: string;
  readonly secret?: Uint8Array;
  readonly live?: boolean;
  readonly touch_due?: boolean;
  readonly method?: string;
  readonly step_up_method?: string | null;
}

export const AUTHENTICATED_AT = new Date('2026-10-31T10:00:00.000Z');
export const EXPIRES_AT = new Date('2026-11-30T10:00:00.000Z');

// The proof row the first statement returns, as the database would.
export function sessionRow(shape: RowShape = {}): Record<string, unknown> {
  return {
    id: shape.id ?? SESSION,
    user_id: shape.user_id ?? USER,
    secret_hash: sha(shape.secret ?? SECRET),
    method: shape.method ?? 'email',
    step_up_method: shape.step_up_method ?? null,
    authenticated_at: AUTHENTICATED_AT,
    expires_at: EXPIRES_AT,
    live: shape.live ?? true,
    touch_due: shape.touch_due ?? false,
  };
}

export const isProof = (s: Statement) => /^select\b/i.test(s.sql) && s.sql.includes('"sessions"');
export const isEmailRead = (s: Statement) => /^select\b/i.test(s.sql) && s.sql.includes('"users"');

// Answers the proof with the row whose id matches the first parameter, and the email read
// with one address.
export function sessionResponder(rows: readonly Record<string, unknown>[]): Responder {
  return (statement) => {
    if (isProof(statement)) {
      return rows.filter((row) => statement.parameters.includes(row['id']));
    }
    if (isEmailRead(statement)) return [{ email: 'person@example.com' }];
    return [];
  };
}

export function capturingLogger() {
  const lines: { event: string; fields: Readonly<Record<string, unknown>> }[] = [];
  const logger: AuthLogger = {
    warn(event, fields) {
      lines.push({ event, fields });
    },
  };
  return { logger, lines };
}

export function noopLimiter(): RateLimiter & { calls: [string, readonly unknown[]][] } {
  const calls: [string, readonly unknown[]][] = [];
  return {
    calls,
    keyFor: () => Buffer.alloc(32),
    reserve(bucket, value) {
      calls.push([bucket, value]);
      return Promise.resolve();
    },
  };
}

export function browser(cookies: Record<string, string> = {}): BrowserContext {
  return {
    ip: '203.0.113.7',
    userAgent: 'Mozilla/5.0 (test)',
    cookies: new Map(Object.entries(cookies)),
  };
}

export const sessionInfo = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId: SESSION,
  userId: USER,
  email: 'person@example.com',
  authenticatedAt: AUTHENTICATED_AT,
  expiresAt: EXPIRES_AT,
  method: 'email',
  ...overrides,
});

// The handles are never opened: every test hands in a scripted store.
export function setup(
  respond: Responder = sessionResponder([sessionRow()]),
  extra: Partial<SessionsDeps> = {},
  cfg: AuthConfig = config,
) {
  const scripted = scriptedStore(respond);
  const { logger, lines } = capturingLogger();
  const limiter = noopLimiter();
  const sessions = createSessions(cfg, {
    db: {} as Database,
    authDb: {} as AuthDatabase,
    logger,
    limiter,
    store: scripted.store,
    random: (n) => Buffer.alloc(n, 5),
    ...extra,
  });
  return { sessions, scripted, lines, limiter };
}
