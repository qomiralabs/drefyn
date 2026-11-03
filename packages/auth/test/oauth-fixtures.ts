import { idOf, type UserId } from '@drefyn/tenancy';
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import {
  AuthError,
  createEmailSignIn,
  createOAuth,
  parseAuthConfig,
  type AuthConfig,
  type AuthLogger,
  type BrowserContext,
  type CookieSpec,
  type OAuthDeps,
  type OAuthProvider,
  type OAuthPurpose,
  type OAuthSessions,
  type SessionInfo,
} from '../src/index.ts';
import { createTestAuthMailer } from '../src/testing.ts';
import { fakeLimiter } from './email-fixtures.ts';
import {
  createFakeProviders,
  oauthEnv,
  type FakeAccount,
  type FakeSettings,
} from './oauth-fakes.ts';
import { oauthStore, type OAuthStore } from './oauth-store.ts';
import { validEnv } from './support.ts';

export const ORIGIN = 'https://app.drefyn.test';

export function oauthConfig(env: Readonly<Record<string, string>> = {}): AuthConfig {
  return parseAuthConfig({ ...validEnv(), ...oauthEnv, DREFYN_AUTH_SIGNUP: 'open', ...env });
}

// A browser's cookies, kept the way a browser keeps them: Max-Age 0 removes one.
export class Jar {
  readonly cookies = new Map<string, string>();
  constructor(
    readonly ip = '203.0.113.7',
    readonly userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Firefox/131.0',
  ) {}
  apply(specs: readonly CookieSpec[]): void {
    for (const spec of specs) {
      if (spec.maxAgeSeconds === 0) this.cookies.delete(spec.name);
      else this.cookies.set(spec.name, spec.value);
    }
  }
  context(): BrowserContext {
    return { ip: this.ip, userAgent: this.userAgent, cookies: new Map(this.cookies) };
  }
}

export interface Logged {
  readonly level: 'info' | 'warn';
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export function logRecorder() {
  const logs: Logged[] = [];
  const logger: AuthLogger = {
    info(event, fields) {
      logs.push({ level: 'info', event, fields });
    },
    warn(event, fields) {
      logs.push({ level: 'warn', event, fields });
    },
  };
  return { logger, logs };
}

// Sessions kept in the same tables, with a cookie that is just the row id: enough for the
// OAuth flows, whose session handling the sessions suite proves on its own.
export function fakeSessions(db: OAuthStore, config: AuthConfig) {
  let recent = true;
  const toInfo = (row: Record<string, unknown>): SessionInfo => {
    const user = db.tables.users.find((u) => u['id'] === row['user_id']);
    return {
      sessionId: idOf('ses', String(row['id'])),
      userId: idOf('usr', String(row['user_id'])),
      email: String(user?.['email_normalized'] ?? 'nobody@example.com'),
      authenticatedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
      method: row['method'] as SessionInfo['method'],
    };
  };
  const sessions: OAuthSessions = {
    startSession: vi.fn(
      (_b: BrowserContext, input: { userId: UserId; method: SessionInfo['method'] }) => {
        const row = { id: randomUUID(), user_id: input.userId, method: input.method };
        db.tables.sessions.push(row);
        return Promise.resolve({
          session: toInfo(row),
          setCookies: [
            { name: config.cookies.session, value: `s.${row.id}`, maxAgeSeconds: 60 },
            { name: config.cookies.pre, value: '', maxAgeSeconds: 0 },
            { name: config.cookies.oauth, value: '', maxAgeSeconds: 0 },
          ],
        });
      },
    ),
    resolveSession: vi.fn((cookie: string | undefined) => {
      const row = db.tables.sessions.find((s) => `s.${String(s['id'])}` === cookie);
      return Promise.resolve(row === undefined ? null : toInfo(row));
    }),
    requireRecentAuth: vi.fn(() =>
      Promise.resolve(
        recent
          ? { ok: true as const, value: undefined }
          : { ok: false as const, error: new AuthError('AUTH_RECENT_AUTH_REQUIRED') },
      ),
    ),
  };
  return {
    sessions,
    setRecent(value: boolean) {
      recent = value;
    },
  };
}

export function setup(
  options: {
    readonly env?: Readonly<Record<string, string>>;
    readonly fakes?: FakeSettings;
    readonly deps?: Partial<OAuthDeps>;
  } = {},
) {
  const config = oauthConfig(options.env);
  const db = oauthStore();
  const fakes = createFakeProviders(options.fakes);
  const { logger, logs } = logRecorder();
  const mail = createTestAuthMailer();
  const s = fakeSessions(db, config);
  const limiter = fakeLimiter();
  const deps: OAuthDeps = {
    store: db.store,
    logger,
    mailer: mail.mailer,
    sessions: s.sessions,
    limiter,
    oauthTransport: fakes.transport,
    ...options.deps,
  };
  const oauth = createOAuth(config, deps);
  const email = createEmailSignIn(config, {
    store: db.store,
    logger,
    mailer: mail.mailer,
    sessions: s.sessions,
    limiter,
  });
  return { config, db, fakes, logs, mail, sessions: s, limiter, oauth, email };
}

export type Setup = ReturnType<typeof setup>;

export function user(t: Setup, email: string): UserId {
  const id = randomUUID();
  t.db.tables.users.push({ id, email, email_normalized: email });
  return idOf('usr', id);
}

export function identity(t: Setup, userId: UserId, account: FakeAccount): void {
  t.db.tables.identities.push({
    id: randomUUID(),
    user_id: userId,
    provider: account.provider,
    provider_subject: account.provider === 'github' ? String(account.id) : account.sub,
    provider_email_normalized:
      account.provider === 'github' ? account.emails[0]?.email : account.email,
  });
}

// A signed in browser for the user, as sign in would leave it.
export async function signedIn(t: Setup, userId: UserId, jar = new Jar()) {
  const started = await t.sessions.sessions.startSession(jar.context(), {
    userId,
    method: 'email',
  });
  jar.apply(started.setCookies);
  return { jar, session: started.session };
}

export async function begin(
  t: Setup,
  provider: OAuthProvider,
  options: {
    readonly jar?: Jar;
    readonly purpose?: OAuthPurpose;
    readonly session?: SessionInfo;
    readonly returnTo?: string;
  } = {},
) {
  const jar = options.jar ?? new Jar();
  const started = await t.oauth.startOAuth(jar.context(), {
    provider,
    purpose: options.purpose ?? 'sign_in',
    ...(options.session === undefined ? {} : { session: options.session }),
    ...(options.returnTo === undefined ? {} : { returnTo: options.returnTo }),
  });
  if (!started.ok) throw started.error;
  jar.apply(started.value.setCookies);
  return { jar, url: started.value.redirectTo, setCookies: started.value.setCookies };
}

// Start, approve at the fake provider as the account, and come back to the callback.
export async function roundTrip(
  t: Setup,
  account: FakeAccount,
  options: Parameters<typeof begin>[2] & {
    readonly edit?: (query: URLSearchParams, jar: Jar) => void;
    readonly callbackProvider?: OAuthProvider;
  } = {},
) {
  const { jar, url } = await begin(t, account.provider, options);
  const { query, asked } = t.fakes.approve(url, account);
  options.edit?.(query, jar);
  const done = await t.oauth.completeOAuth(jar.context(), {
    provider: options.callbackProvider ?? account.provider,
    query,
  });
  if (done.ok) jar.apply(done.value.setCookies);
  return { jar, url, asked, query, done };
}

export const codeOf = (result: { ok: boolean; error?: unknown }) =>
  result.ok ? 'ok' : result.error instanceof AuthError ? result.error.code : 'not an AuthError';

export const writesTo = (t: Setup, table: string) =>
  t.db.scripted
    .writes()
    .filter((s) => new RegExp(`^\\s*(insert into|update|delete from) "${table}"`, 'i').test(s.sql));
