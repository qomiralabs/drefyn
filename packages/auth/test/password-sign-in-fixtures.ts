import { vi } from 'vitest';
import {
  AuthError,
  createPasswordSignIn,
  encodeSecret,
  parseAuthConfig,
  type AuthConfig,
  type BrowserContext,
  type Env,
  type PasswordHasher,
  type PasswordSignInDeps,
  type RateBucket,
  type RateLimiter,
} from '../src/index.ts';
import {
  ADDRESS,
  IP,
  PRE,
  PRE_COOKIE,
  fakeLimiter,
  on,
  recordingLogger,
  session,
} from './email-fixtures.ts';
import { smallHasher } from './password-fixtures.ts';
import { scriptedStore, type Responder } from './scripted-store.ts';
import { USER, config } from './session-fixtures.ts';
import { validEnv } from './support.ts';

export { ADDRESS, IP, PRE, PRE_COOKIE, USER, config, session };

export const PASSWORD = 'a long and quiet sentence';

export const configWith = (env: Env): AuthConfig => parseAuthConfig({ ...validEnv(), ...env });

// The binding field the form GET would have rendered for this pre cookie.
export const csrfFor = (c: AuthConfig, pre: Buffer = PRE) =>
  createPasswordSignIn(c, {
    store: scriptedStore().store,
    logger: recordingLogger().logger,
    limiter: fakeLimiter(),
    sessions: fakePasswordSessions(),
  }).passwordForm({
    ip: IP,
    userAgent: 'x',
    cookies: new Map([[c.cookies.pre, encodeSecret(pre)]]),
  }).csrf;

export const passwordBrowser = (
  c: AuthConfig = config,
  pre: string | null = PRE_COOKIE,
): BrowserContext => ({
  ip: IP,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Firefox/140.0',
  cookies: new Map(pre === null ? [] : [[c.cookies.pre, pre]]),
});

export interface StoredUser {
  readonly known: boolean;
  readonly phc?: string | null;
}

// Answers the one sign in read and the device writes.
export function passwordResponder(user: StoredUser, reread?: StoredUser): Responder {
  let reads = 0;
  return (s) => {
    if (on(s, 'select', 'users')) {
      reads += 1;
      const current = reads > 1 && reread !== undefined ? reread : user;
      return current.known ? [{ id: USER, phc: current.phc ?? null }] : [];
    }
    if (on(s, 'select', 'password_credentials')) {
      return user.phc === undefined || user.phc === null ? [] : [{ phc: user.phc }];
    }
    if (on(s, 'insert', 'password_credentials')) return [{ user_id: USER }];
    return [];
  };
}

export const fakePasswordSessions = () => ({
  startSession: vi.fn(
    (_b: BrowserContext, _input: { readonly credential?: { readonly phc: string } }) =>
      Promise.resolve({
        session: { ...session, method: 'password' as const },
        setCookies: [{ name: config.cookies.session, value: 'v1.x', maxAgeSeconds: 60 }],
      }),
  ),
  requireRecentAuth: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
});

// A hasher that records each call and whether a transaction was open at the time.
export function spyHasher(inner: PasswordHasher = smallHasher(), open: () => number = () => 0) {
  const calls: { kind: 'hash' | 'check' | 'verify'; phc: string | null; open: number }[] = [];
  const hasher: PasswordHasher = {
    hash(password) {
      calls.push({ kind: 'hash', phc: null, open: open() });
      return inner.hash(password);
    },
    check(phc, password) {
      calls.push({ kind: 'check', phc, open: open() });
      return inner.check(phc, password);
    },
    verify(phc, password) {
      calls.push({ kind: 'verify', phc, open: open() });
      return inner.verify(phc, password);
    },
  };
  return { hasher, calls };
}

// A limiter that counts like the real one inside a single window, per bucket and key.
export function countingLimiter(c: AuthConfig = config): RateLimiter & {
  readonly reserved: RateBucket[];
} {
  const counts = new Map<string, number>();
  const reserved: RateBucket[] = [];
  return {
    reserved,
    keyFor: (bucket, value) => c.keys.mac('rate', [bucket, ...value]),
    reserve(bucket, value) {
      reserved.push(bucket);
      const key = `${bucket}:${c.keys.mac('rate', [bucket, ...value]).toString('hex')}`;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      const limit = Math.min(...c.rateLimits[bucket].map((l) => l.count));
      if (count > limit) {
        return Promise.reject(new AuthError('AUTH_RATE_LIMITED', { retryAfterSeconds: 60 }));
      }
      return Promise.resolve();
    },
  };
}

export function passwordDeps(
  user: StoredUser = { known: true, phc: null },
  extra: Partial<PasswordSignInDeps> = {},
  reread?: StoredUser,
) {
  const scripted = scriptedStore(passwordResponder(user, reread));
  const { logger, logs } = recordingLogger();
  const sessions = fakePasswordSessions();
  const limiter = fakeLimiter();
  const spy = spyHasher(smallHasher(), () => scripted.open);
  return {
    scripted,
    logs,
    sessions,
    limiter,
    spy,
    deps: {
      store: scripted.store,
      logger,
      sessions,
      limiter,
      hasher: spy.hasher,
      ...extra,
    } satisfies PasswordSignInDeps,
  };
}
