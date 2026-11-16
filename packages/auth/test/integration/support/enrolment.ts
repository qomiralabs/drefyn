import { randomBytes } from 'node:crypto';
import type { UserId } from '@drefyn/tenancy';
import { expect } from 'vitest';
import {
  createEmailSignIn,
  createOAuth,
  createPasswordAccount,
  createPasswordSignIn,
  createSecondFactors,
  createSessions,
  type AuthConfig,
  type CookieSpec,
  type OAuthPurpose,
  type SessionInfo,
} from '../../../src/index.ts';
import { createTestAuthMailer } from '../../../src/testing.ts';
import { createFakeProviders, oauthEnv, type FakeAccount } from '../../oauth-fakes.ts';
import { Jar } from '../../oauth-fixtures.ts';
import { asSignedIn } from '../../support.ts';
import { newBrowser, type Browser } from './email.ts';
import { TOTP_SECRET, challengesFor, currentCode, factorConfig } from './factor.ts';
import type { Harness } from './harness.ts';
import { SMALL, hasherAt, loggerFor } from './passwords.ts';

export const PASSWORD = 'a long and quiet sentence';

// Everything enrolment touches, wired the way the dashboard wires it. The TOTP secret is the
// fixed test one, so the code an app would show can be computed from the database clock.
export function enrolmentWorld(
  h: Harness,
  options: { readonly env?: Readonly<Record<string, string>>; readonly flag?: boolean } = {},
) {
  const config: AuthConfig = factorConfig({ ...oauthEnv, ...options.env });
  const mail = createTestAuthMailer();
  const logger = loggerFor(h);
  const hasher = hasherAt(SMALL);
  const sessions = createSessions(config, {
    db: h.db,
    authDb: h.authDb,
    logger,
    mailer: mail.mailer,
    passwords: hasher,
  });
  const shared = { db: h.db, authDb: h.authDb, logger, mailer: mail.mailer, sessions };
  const fakes = createFakeProviders({ authTimeAgoSeconds: 10 });
  const tasks: (() => Promise<void>)[] = [];
  const later = (task: () => Promise<void>) => {
    tasks.push(task);
  };
  let flag = options.flag ?? true;
  const factors = createSecondFactors(config, {
    db: h.db,
    authDb: h.authDb,
    logger,
    mailer: mail.mailer,
    flag: { isOn: () => Promise.resolve(flag) },
    random: (n) => (n === TOTP_SECRET.length ? Buffer.from(TOTP_SECRET) : randomBytes(n)),
    later,
  });
  return {
    config,
    mail,
    sessions,
    factors,
    fakes,
    signIn: createPasswordSignIn(config, { ...shared, hasher }),
    password: createPasswordAccount(config, { ...shared, hasher, later }),
    email: createEmailSignIn(config, shared),
    oauth: createOAuth(config, { ...shared, oauthTransport: fakes.transport }),
    challenges: challengesFor(h, config, { later, mailer: mail.mailer }),
    setFlag(on: boolean) {
      flag = on;
    },
    // Runs the notices a refusal left to run after its answer.
    async drain() {
      for (const task of tasks.splice(0)) await task();
    },
  };
}

export type EnrolmentWorld = ReturnType<typeof enrolmentWorld>;

export async function signedIn(w: EnrolmentWorld, userId: UserId, b: Browser = newBrowser()) {
  const started = await w.sessions.startSession(b.context(), { userId, method: 'email' });
  b.apply(started.setCookies);
  return { browser: b, session: asSignedIn(started).session };
}

export async function stepUpByEmail(w: EnrolmentWorld, b: Browser, s: SessionInfo) {
  const started = await w.sessions.startStepUpCode(b.context(), s);
  if (!started.ok) throw started.error;
  const before = w.mail.sent.length;
  await started.value.send();
  const code = w.mail.sent.slice(before).at(-1)?.code ?? '';
  return { challenge: started.value.challenge, code };
}

export async function emailStepUp(w: EnrolmentWorld, b: Browser, s: SessionInfo) {
  const { challenge, code } = await stepUpByEmail(w, b, s);
  const done = await w.sessions.verifyStepUpCode(b.context(), s, { challenge, code });
  if (!done.ok) throw done.error;
  return done.value;
}

export async function setPassword(w: EnrolmentWorld, s: SessionInfo) {
  const set = await w.signIn.setPassword(s, { newPassword: PASSWORD });
  if (!set.ok) throw set.error;
}

export async function passwordStepUp(w: EnrolmentWorld, b: Browser, s: SessionInfo) {
  const done = await w.sessions.stepUpWithPassword(b.context(), s, { password: PASSWORD });
  if (!done.ok) throw done.error;
  return done.value;
}

// Start and confirm with the code the app shows now. Returns the recovery codes.
export async function enrollNow(h: Harness, w: EnrolmentWorld, b: Browser, s: SessionInfo) {
  const started = await w.factors.startEnrollment(b.context(), s);
  if (!started.ok) throw started.error;
  const code = await currentCode(h);
  const confirmed = await w.factors.confirmEnrollment(b.context(), s, { code });
  if (!confirmed.ok) throw confirmed.error;
  if (confirmed.value.kind !== 'enrolled') throw new Error('the current code was refused');
  b.apply(confirmed.value.setCookies);
  return { codes: confirmed.value.recoveryCodes, code, send: confirmed.value.send };
}

// A person who stepped up by email a moment ago and holds a confirmed factor.
export async function enrolledPerson(h: Harness, w: EnrolmentWorld, label = 'p') {
  const userId = await h.user(`${label}${randomBytes(4).toString('hex')}@enrol.example.com`);
  const { browser, session } = await signedIn(w, userId);
  const stepped = await emailStepUp(w, browser, session);
  const enrolled = await enrollNow(h, w, browser, stepped);
  return { userId, browser, session: stepped, ...enrolled };
}

// One OAuth round trip through the fake provider, as the callback route runs it.
export async function oauthTrip(
  w: EnrolmentWorld,
  account: FakeAccount,
  options: {
    readonly jar?: Jar;
    readonly purpose?: OAuthPurpose;
    readonly session?: SessionInfo;
    readonly beforeCallback?: () => Promise<void>;
  } = {},
) {
  const jar = options.jar ?? new Jar();
  const started = await w.oauth.startOAuth(jar.context(), {
    provider: account.provider,
    purpose: options.purpose ?? 'sign_in',
    ...(options.session === undefined ? {} : { session: options.session }),
  });
  if (!started.ok) return { jar, started, done: null };
  jar.apply(started.value.setCookies);
  const { query } = w.fakes.approve(started.value.redirectTo, account);
  await options.beforeCallback?.();
  const done = await w.oauth.completeOAuth(jar.context(), { provider: account.provider, query });
  if (done.ok) jar.apply(done.value.setCookies);
  return { jar, started, done };
}

export const ageSession = (h: Harness, s: SessionInfo, minutes: number) =>
  h.sql(
    `update app.sessions set authenticated_at = now() - make_interval(mins => ${String(minutes)}) where id = '${s.sessionId}';`,
  );

export const agePassword = (h: Harness, userId: UserId, hours: number) =>
  h.sql(
    `update app.password_credentials set updated_at = now() - make_interval(hours => ${String(hours)}) where user_id = '${userId}';`,
  );

export const errorOf = (result: { ok: boolean; error?: { code: string } } | null) =>
  result === null ? 'none' : result.ok ? 'ok' : result.error?.code;

export function expectCookie(cookies: readonly CookieSpec[], name: string) {
  expect(cookies.map((c) => c.name)).toContain(name);
}
