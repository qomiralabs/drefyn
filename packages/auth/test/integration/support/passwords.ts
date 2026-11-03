import { randomBytes } from 'node:crypto';
import {
  createPasswordHasher,
  createPasswordSignIn,
  createSessions,
  parseAuthConfig,
  type Argon2Params,
  type AuthConfig,
  type AuthLogger,
  type PasswordHasher,
  type PasswordSignInDeps,
  type SessionInfo,
} from '../../../src/index.ts';
import { validEnv } from '../../support.ts';
import { ROOMY_LIMITS, newBrowser, type Browser } from './email.ts';
import type { Harness } from './harness.ts';

// Tiny parameters unless a test is about cost: the code path is the same.
export const SMALL: Argon2Params = { memoryKib: 64, passes: 1, parallelism: 1 };
export const BIGGER: Argon2Params = { memoryKib: 128, passes: 1, parallelism: 1 };

export const ROOMY_PASSWORD_LIMITS = {
  ...ROOMY_LIMITS,
  DREFYN_AUTH_RATE_PASSWORD_FAIL: '1000/15m',
  DREFYN_AUTH_RATE_PASSWORD_FAIL_IP: '1000/10m',
} as const;

export function passwordConfig(env: Readonly<Record<string, string>> = {}): AuthConfig {
  return parseAuthConfig({
    ...validEnv(randomBytes(32).toString('base64url')),
    ...ROOMY_PASSWORD_LIMITS,
    ...env,
  });
}

export const hasherAt = (params: Argon2Params, floor: Argon2Params = SMALL): PasswordHasher =>
  createPasswordHasher({ params, floor, concurrency: 4, queueMax: 64 });

export function loggerFor(h: Harness): AuthLogger {
  return {
    info(event, fields) {
      h.logs.push({ level: 'info', event, fields });
    },
    warn(event, fields) {
      h.logs.push({ level: 'warn', event, fields });
    },
  };
}

export function passwordFlow(
  h: Harness,
  config: AuthConfig,
  hasher: PasswordHasher = hasherAt(SMALL),
  extra: Partial<PasswordSignInDeps> = {},
) {
  const logger = loggerFor(h);
  const sessions = createSessions(config, {
    db: h.db,
    authDb: h.authDb,
    logger,
    passwords: hasher,
  });
  const signIn = createPasswordSignIn(config, {
    db: h.db,
    authDb: h.authDb,
    logger,
    sessions,
    hasher,
    ...extra,
  });
  return { config, sessions, signIn, hasher };
}

export type PasswordFlow = ReturnType<typeof passwordFlow>;

// A person who proved their address by email and then chose a password.
export async function personWithPassword(
  h: Harness,
  flow: PasswordFlow,
  password: string,
  email = `p${randomBytes(4).toString('hex')}@example.com`,
): Promise<{ readonly email: string; readonly session: SessionInfo }> {
  const userId = await h.user(email);
  const started = await flow.sessions.startSession(newBrowser().context(), {
    userId,
    method: 'email',
  });
  const set = await flow.signIn.setPassword(started.session, { newPassword: password });
  if (!set.ok) throw set.error;
  return { email, session: started.session };
}

// GET the form, then POST it from the same browser, as the page does.
export async function signInFrom(
  flow: PasswordFlow,
  browser: Browser,
  email: string,
  password: string,
) {
  const form = flow.signIn.passwordForm(browser.context());
  browser.apply(form.setCookies);
  return flow.signIn.signInWithPassword(browser.context(), { email, password, csrf: form.csrf });
}

export const phcOf = (h: Harness, email: string) =>
  h.sql(
    `select coalesce((select c.phc from app.password_credentials c join app.users u on u.id = c.user_id where u.email_normalized = '${email}'), '-');`,
  );

export const sessionsOf = (h: Harness, email: string, method = 'password') =>
  h.sql(
    `select count(*) from app.sessions s join app.users u on u.id = s.user_id where u.email_normalized = '${email}' and s.method = '${method}';`,
  );

// Holds a hasher's check open until the test lets it go, to interleave steps 1 and 3.
export function heldHasher(inner: PasswordHasher) {
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const inside = new Promise<void>((resolve) => (entered = resolve));
  let held = false;
  const hasher: PasswordHasher = {
    hash: (password) => inner.hash(password),
    verify: (phc, password) => inner.verify(phc, password),
    async check(phc, password) {
      if (!held) {
        held = true;
        entered();
        await gate;
      }
      return inner.check(phc, password);
    },
  };
  return {
    hasher,
    release: () => {
      release();
    },
    inside,
  };
}

// Rate windows are aligned to the database clock. Waits until a test fits in one window of
// the given length, so an edge in the middle never resets a count it relies on.
export async function insideWindow(h: Harness, windowSeconds: number, budgetSeconds: number) {
  const left = Number(
    await h.sql(
      `select ${String(windowSeconds)} - mod(floor(extract(epoch from now()))::bigint, ${String(windowSeconds)});`,
    ),
  );
  if (left > budgetSeconds) return;
  await new Promise((resolve) => setTimeout(resolve, (left + 1) * 1000));
}
