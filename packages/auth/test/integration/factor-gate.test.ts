import { withAuth, withUser } from '@drefyn/db';
import type { UserId } from '@drefyn/tenancy';
import { sql } from 'kysely';
import { beforeAll, expect, it } from 'vitest';
import {
  createCliLinks,
  createEmailChange,
  createEmailSignIn,
  createOAuth,
  createOperatorSessions,
  createPasswordAccount,
  createPasswordSignIn,
  createSessions,
  formatChallengeId,
  parseFactorToken,
  type AuthConfig,
  type BrowserContext,
  type CookieSpec,
  type FactorChallenges,
  type PasswordHasher,
  type SessionInfo,
  type SessionStore,
} from '../../src/index.ts';
import { lockFactor } from '../../src/factor-rows.ts';
import { createTestAuthMailer } from '../../src/testing.ts';
import { createFakeProviders, githubAccount, googleAccount, oauthEnv } from '../oauth-fakes.ts';
import { Jar } from '../oauth-fixtures.ts';
import { asSignedIn } from '../support.ts';
import { newBrowser, requestCode, type Browser } from './support/email.ts';
import {
  challengesFor,
  challengesOf,
  count,
  currentCode,
  enroll,
  factorConfig,
  factorPost,
  sessionsOf,
  unusedCodesOf,
  wrongTotp,
} from './support/factor.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';
import { SMALL, hasherAt, loggerFor, phcOf, signInFrom } from './support/passwords.ts';

const PASSWORD = 'a long and quiet sentence';
const NEW_PASSWORD = 'a fresh sentence after the reset';
const fresh = harness();
let h: Harness;
let n = 0;
const address = (label: string) => `${label}${String((n += 1))}@factor.example.com`;

function world(config: AuthConfig = factorConfig(oauthEnv), hasher?: PasswordHasher) {
  const mail = createTestAuthMailer();
  const logger = loggerFor(h);
  const hash = hasher ?? hasherAt(SMALL);
  const sessions = createSessions(config, {
    db: h.db,
    authDb: h.authDb,
    logger,
    mailer: mail.mailer,
    passwords: hash,
  });
  const shared = { db: h.db, authDb: h.authDb, logger, mailer: mail.mailer, sessions };
  const fakes = createFakeProviders();
  return {
    config,
    mail,
    sessions,
    hasher: hash,
    fakes,
    email: createEmailSignIn(config, shared),
    password: { ...createPasswordAccount(config, { ...shared, hasher: hash }) },
    signIn: createPasswordSignInFor(config, shared, hash),
    oauth: createOAuth(config, { ...shared, oauthTransport: fakes.transport }),
    cli: createCliLinks(config, { ...shared, initialTier: 'self_hosted' }),
    challenges: challengesFor(h, config),
  };
}

type World = ReturnType<typeof world>;

function createPasswordSignInFor(
  config: AuthConfig,
  shared: Parameters<typeof createPasswordSignIn>[1],
  hasher: PasswordHasher,
) {
  return createPasswordSignIn(config, { ...shared, hasher });
}

const userIdOf = async (email: string) =>
  (await h.sql(`select id from app.users where email_normalized = '${email}';`)).trim() as UserId;

async function person(w: World, label: string, withPassword = false) {
  const email = address(label);
  const userId = await h.user(email);
  if (withPassword) {
    const started = asSignedIn(
      await w.sessions.startSession(newBrowser().context(), { userId, method: 'email' }),
    );
    const set = await w.signIn.setPassword(started.session, { newPassword: PASSWORD });
    if (!set.ok) throw set.error;
    await h.sql(`delete from app.sessions where user_id = '${userId}';`);
  }
  return { email, userId };
}

function gated(value: object, b: { apply(c: readonly CookieSpec[]): void }) {
  expect(value).toMatchObject({ kind: 'factor_required' });
  b.apply((value as { setCookies: readonly CookieSpec[] }).setCookies);
}

async function pass(
  w: World,
  b: Browser | Jar,
  kind: 'totp' | 'recovery_code',
  code: string,
  challenges: FactorChallenges = w.challenges,
) {
  const post = factorPost(w.config, b, kind, code);
  const done = await challenges.completeChallenge(context(b), post);
  if (done.ok) b.apply(done.value.setCookies);
  return done;
}

const context = (b: Browser | Jar): BrowserContext => b.context();

async function emailCode(w: World, b: Browser, email: string) {
  const sent = await requestCode(
    { config: w.config, mail: w.mail, signIn: w.email, sessions: w.sessions },
    b,
    email,
  );
  if (sent === null) throw new Error('no code');
  return w.email.verifyEmailCode(b.context(), { code: sent.code });
}

describeWithStack('the second factor gate on every way in', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  it('email code: no session without a valid code, one with it', async () => {
    const w = world();
    const { email, userId } = await person(w, 'email');
    await enroll(h, userId, w.config);
    const b = newBrowser();
    const done = await emailCode(w, b, email);
    if (!done.ok) throw done.error;
    gated(done.value, b);
    expect(await sessionsOf(h, userId)).toBe(0);
    expect(await challengesOf(h, userId)).toBe(1);
    // The cookie names the person and is stored only as a hash.
    const token = parseFactorToken(b.cookies.get(w.config.cookies.factor));
    expect(token?.userId).toBe(userId);
    const wrong = await pass(w, b, 'totp', wrongTotp(await currentCode(h)));
    expect(!wrong.ok && wrong.error.code).toBe('AUTH_FACTOR_INVALID');
    expect(await sessionsOf(h, userId)).toBe(0);
    const right = await pass(w, b, 'totp', await currentCode(h));
    if (!right.ok) throw right.error;
    expect(right.value.session.method).toBe('email');
    expect(await sessionsOf(h, userId)).toBe(1);
    expect(await challengesOf(h, userId)).toBe(0);
    expect(b.cookies.has(w.config.cookies.factor)).toBe(false);
    expect(b.cookies.has(w.config.cookies.session)).toBe(true);
    // The resolved session is a normal one.
    const resolved = await w.sessions.resolveSession(b.cookies.get(w.config.cookies.session));
    expect(resolved?.userId).toBe(userId);
  });

  it('password: no session without a valid code, one with a recovery code, rehash kept', async () => {
    const w = world();
    const { email, userId } = await person(w, 'password', true);
    const codes = await enroll(h, userId, w.config);
    const b = newBrowser();
    const done = await signInFrom(w, b, email, PASSWORD);
    if (!done.ok) throw done.error;
    gated(done.value, b);
    expect(await sessionsOf(h, userId)).toBe(0);
    const right = await pass(w, b, 'recovery_code', codes[0] ?? '');
    if (!right.ok) throw right.error;
    expect(right.value.session.method).toBe('password');
    expect(await unusedCodesOf(h, userId)).toBe(9);
    // The same code twice is refused.
    const again = await signInFrom(w, b, email, PASSWORD);
    if (!again.ok) throw again.error;
    gated(again.value, b);
    const replay = await pass(w, b, 'recovery_code', codes[0] ?? '');
    expect(!replay.ok && replay.error.code).toBe('AUTH_FACTOR_INVALID');
  });

  it.each(['github', 'google'] as const)(
    '%s: no session without a valid code, one with it',
    async (provider) => {
      const w = world();
      const email = address(provider);
      const account =
        provider === 'github'
          ? githubAccount(email, { id: 70_000 + (n += 1), login: `f${String(n)}` })
          : googleAccount(email, { sub: `g-${String((n += 1))}` });
      const first = await trip(w, account);
      if (!first.done.ok) throw first.done.error;
      expect(first.done.value.kind).toBe('signed_in');
      const userId = await userIdOf(email);
      const codes = await enroll(h, userId, w.config);
      await h.sql(`delete from app.sessions where user_id = '${userId}';`);
      const second = await trip(w, account);
      if (!second.done.ok) throw second.done.error;
      expect(second.done.value.kind).toBe('factor_required');
      expect(await sessionsOf(h, userId)).toBe(0);
      const right = await pass(w, second.jar, 'recovery_code', codes[1] ?? '');
      if (!right.ok) throw right.error;
      expect(right.value.session.method).toBe(provider);
    },
  );

  it('CLI link: the link is spent, then the challenge; no session without it', async () => {
    const w = world();
    const { email, userId } = await person(w, 'cli');
    const codes = await enroll(h, userId, w.config);
    const issued = await w.cli.issue({ email });
    if (!issued.ok) throw issued.error;
    const token = new URL(issued.value.link).hash.slice(1);
    const jar = new Jar('203.0.113.40');
    const done = await w.cli.redeem(jar.context(), token);
    if (!done.ok) throw done.error;
    expect(done.value.kind).toBe('factor_required');
    jar.apply(done.value.setCookies);
    expect(await sessionsOf(h, userId)).toBe(0);
    expect(await count(h, `app.cli_sign_in_links where consumed_at is not null`)).toBeGreaterThan(
      0,
    );
    const right = await pass(w, jar, 'recovery_code', codes[2] ?? '');
    if (!right.ok) throw right.error;
    expect(right.value.session.method).toBe('cli_link');
  });

  it('reset: the hash is unchanged until the factor passes; without one, nothing is spent', async () => {
    const w = world();
    const { email, userId } = await person(w, 'reset', true);
    const codes = await enroll(h, userId, w.config);
    const before = await phcOf(h, email);
    const b = newBrowser();
    const sent = await requestReset(w, b, email);
    const bare = await w.password.completePasswordReset(b.context(), {
      code: sent.code,
      newPassword: NEW_PASSWORD,
    });
    expect(!bare.ok && bare.error.code).toBe('AUTH_FACTOR_REQUIRED');
    expect(await phcOf(h, email)).toBe(before);
    expect(await unusedCodesOf(h, userId)).toBe(10);
    expect(
      await count(
        h,
        `app.email_challenges where consumed_at is not null and user_id = '${userId}'`,
      ),
    ).toBe(0);
    const wrong = await w.password.completePasswordReset(b.context(), {
      code: sent.code,
      newPassword: NEW_PASSWORD,
      factor: { kind: 'totp', code: wrongTotp(await currentCode(h)) },
    });
    expect(!wrong.ok && wrong.error.code).toBe('AUTH_FACTOR_INVALID');
    expect(await phcOf(h, email)).toBe(before);
    const right = await w.password.completePasswordReset(b.context(), {
      code: sent.code,
      newPassword: NEW_PASSWORD,
      factor: { kind: 'recovery_code', code: codes[0] ?? '' },
    });
    if (!right.ok) throw right.error;
    expect(right.value).toMatchObject({ session: { userId } });
    expect(await phcOf(h, email)).not.toBe(before);
    expect(await unusedCodesOf(h, userId)).toBe(9);
    expect(await sessionsOf(h, userId)).toBe(1);
  });

  it('without enrolment every way in is as before', async () => {
    const w = world();
    const { email, userId } = await person(w, 'plain', true);
    const b = newBrowser();
    const done = await signInFrom(w, b, email, PASSWORD);
    if (!done.ok) throw done.error;
    expect(asSignedIn(done.value).session.userId).toBe(userId);
    expect(await challengesOf(h, userId)).toBe(0);
  });

  it('the gate reads rows alone: with no key the row still requires the factor', async () => {
    const keyed = world();
    const { email, userId } = await person(keyed, 'keyless');
    const codes = await enroll(h, userId, keyed.config);
    // The same deployment with the key taken away and enrolment off.
    const w = world(factorConfig({ ...oauthEnv, DREFYN_AUTH_TOTP_KEYS: '' }));
    expect(w.config.totp.available).toBe(false);
    const b = newBrowser();
    const done = await emailCode(w, b, email);
    if (!done.ok) throw done.error;
    gated(done.value, b);
    const totp = await pass(w, b, 'totp', await currentCode(h));
    expect(!totp.ok && totp.error.code).toBe('AUTH_UNAVAILABLE');
    expect(h.logs.map((l) => l.event)).toContain('auth.totp_key_absent');
    expect(await sessionsOf(h, userId)).toBe(0);
    const recovery = await pass(w, b, 'recovery_code', codes[0] ?? '');
    if (!recovery.ok) throw recovery.error;
    expect(await sessionsOf(h, userId)).toBe(1);
  });

  it('a row sealed under a key no longer configured fails closed and is logged', async () => {
    const keyed = world();
    const { email, userId } = await person(keyed, 'rotated');
    await enroll(h, userId, keyed.config);
    const w = world(factorConfig({ ...oauthEnv, DREFYN_AUTH_TOTP_KEYS: `k2:${'A'.repeat(43)}` }));
    const b = newBrowser();
    const done = await emailCode(w, b, email);
    if (!done.ok) throw done.error;
    gated(done.value, b);
    const totp = await pass(w, b, 'totp', await currentCode(h));
    expect(!totp.ok && totp.error.code).toBe('AUTH_UNAVAILABLE');
    expect(h.logs.map((l) => l.event)).toContain('auth.totp_key_unreadable');
  });

  it('link on sign in: an enrolled person gets no identity, and the code becomes a challenge', async () => {
    const w = world();
    const { email, userId } = await person(w, 'link');
    await enroll(h, userId, w.config);
    const jar = new Jar('203.0.113.41');
    const account = githubAccount(email, { id: 80_000 + (n += 1), login: `l${String(n)}` });
    const started = await trip(w, account, jar);
    if (!started.done.ok) throw started.done.error;
    expect(started.done.value.kind).toBe('link_pending');
    const sent = w.mail.sent.find((m) => m.to === email);
    if (sent === undefined) throw new Error('no link code');
    const verified = await w.email.verifyEmailCode(jar.context(), { code: sent.code });
    if (!verified.ok) throw verified.error;
    gated(verified.value, jar);
    expect(await count(h, `app.identities where user_id = '${userId}'`)).toBe(0);
    expect(await sessionsOf(h, userId)).toBe(0);
    expect(
      await h.sql(`select method from app.factor_challenges where user_id = '${userId}';`),
    ).toBe('email');
  });

  it('link on sign in, accepted race: enrolment after the read writes the link and no session', async () => {
    const base = world();
    const { email, userId } = await person(base, 'linkrace');
    // The first read of the person's factor rows answers before enrolment lands.
    let reads = 0;
    const store: SessionStore = {
      async user(id, work) {
        const result = await withUser(h.db, { userId: id }, work);
        reads += 1;
        if (reads === 1) await enroll(h, userId, base.config);
        return result;
      },
      auth: (work) => withAuth(h.authDb, work),
    };
    const email2 = createEmailSignIn(base.config, {
      store,
      logger: loggerFor(h),
      mailer: base.mail.mailer,
      sessions: base.sessions,
      limiter: { keyFor: () => Buffer.alloc(32), reserve: () => Promise.resolve() },
    });
    const jar = new Jar('203.0.113.42');
    const account = githubAccount(email, { id: 90_000 + (n += 1), login: `r${String(n)}` });
    await trip(base, account, jar);
    const sent = base.mail.sent.find((m) => m.to === email);
    if (sent === undefined) throw new Error('no link code');
    const verified = await email2.verifyEmailCode(jar.context(), { code: sent.code });
    if (!verified.ok) throw verified.error;
    expect(verified.value).toMatchObject({ kind: 'factor_required' });
    expect(await count(h, `app.identities where user_id = '${userId}'`)).toBe(1);
    expect(await sessionsOf(h, userId)).toBe(0);
  });

  it('reset: a late enrolment is read again under the lock and refused, not skipped', async () => {
    let target: UserId | null = null;
    const inner = hasherAt(SMALL);
    const lateHasher: PasswordHasher = {
      ...inner,
      async hash(password) {
        const out = await inner.hash(password);
        if (target !== null) await enroll(h, target, factorConfig());
        return out;
      },
    };
    const w = world(factorConfig(oauthEnv), lateHasher);
    const { email, userId } = await person(w, 'resetrace', true);
    const before = await phcOf(h, email);
    target = userId;
    const b = newBrowser();
    const sent = await requestReset(w, b, email);
    const done = await w.password.completePasswordReset(b.context(), {
      code: sent.code,
      newPassword: NEW_PASSWORD,
    });
    expect(!done.ok && done.error.code).toBe('AUTH_FACTOR_REQUIRED');
    expect(await phcOf(h, email)).toBe(before);
    expect(await sessionsOf(h, userId)).toBe(0);
  });

  it('reset: a hash queue refusal spends no recovery code', async () => {
    const inner = hasherAt(SMALL);
    const full: PasswordHasher = {
      ...inner,
      hash: () => Promise.reject(new Error('queue full')),
    };
    const w = world(factorConfig(oauthEnv), full);
    const { email, userId } = await person(world(), 'resetfull', true);
    const codes = await enroll(h, userId, w.config);
    const b = newBrowser();
    const sent = await requestReset(w, b, email);
    const done = await w.password.completePasswordReset(b.context(), {
      code: sent.code,
      newPassword: NEW_PASSWORD,
      factor: { kind: 'recovery_code', code: codes[0] ?? '' },
    });
    expect(done.ok).toBe(false);
    expect(await unusedCodesOf(h, userId)).toBe(10);
  });

  it('reset: a crash after the factor is spent and before the hash is written fails safe', async () => {
    const w = world();
    const { email, userId } = await person(w, 'resetcrash', true);
    const codes = await enroll(h, userId, w.config);
    const before = await phcOf(h, email);
    const b = newBrowser();
    const sent = await requestReset(w, b, email);
    // The consume of the email challenge, which follows the spend, fails.
    let auths = 0;
    const account = createPasswordAccount(w.config, {
      db: h.db,
      authDb: h.authDb,
      logger: loggerFor(h),
      mailer: w.mail.mailer,
      sessions: w.sessions,
      hasher: w.hasher,
      store: {
        user: (id, work) => withUser(h.db, { userId: id }, work),
        auth(work) {
          auths += 1;
          if (auths === 3) return Promise.reject(new Error('crash'));
          return withAuth(h.authDb, work);
        },
      },
    });
    const done = await account.completePasswordReset(b.context(), {
      code: sent.code,
      newPassword: NEW_PASSWORD,
      factor: { kind: 'recovery_code', code: codes[0] ?? '' },
    });
    expect(!done.ok && done.error.code).toBe('AUTH_UNAVAILABLE');
    expect(await phcOf(h, email)).toBe(before);
    expect(await unusedCodesOf(h, userId)).toBe(9);
    expect(await sessionsOf(h, userId)).toBe(0);
  });
});

describeWithStack('the factor challenge lifecycle', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  async function challenged(w: World, label: string, withPassword = true) {
    const p = await person(w, label, withPassword);
    const codes = await enroll(h, p.userId, w.config);
    const b = newBrowser();
    const done = await emailCode(w, b, p.email);
    if (!done.ok) throw done.error;
    gated(done.value, b);
    return { ...p, codes, b };
  }

  async function signedInSession(w: World, userId: UserId): Promise<SessionInfo> {
    const b = newBrowser();
    const started = await w.sessions.startSession(b.context(), {
      userId,
      method: 'email',
    });
    if (started.kind === 'session') return started.session;
    // Enrolled: insert a session the way a passed challenge would, for the actions below.
    const id = (
      await h.sql(
        `insert into app.sessions (user_id, secret_hash, method, authenticated_at, last_seen_at, expires_at) values ('${userId}', '\\x${'00'.repeat(32)}', 'email', now(), now(), now() + interval '1 day') returning id;`,
      )
    ).trim();
    const email = (await h.sql(`select email from app.users where id = '${userId}';`)).trim();
    return {
      sessionId: id as SessionInfo['sessionId'],
      userId,
      email,
      authenticatedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
      method: 'email',
    };
  }

  it('a reset during a live challenge kills it', async () => {
    const w = world();
    const c = await challenged(w, 'killreset');
    const other = newBrowser();
    const sent = await requestReset(w, other, c.email);
    const reset = await w.password.completePasswordReset(other.context(), {
      code: sent.code,
      newPassword: NEW_PASSWORD,
      factor: { kind: 'recovery_code', code: c.codes[0] ?? '' },
    });
    if (!reset.ok) throw reset.error;
    const late = await pass(w, c.b, 'recovery_code', c.codes[1] ?? '');
    expect(!late.ok && late.error.code).toBe('AUTH_FACTOR_CHALLENGE_EXPIRED');
  });

  const actions: readonly [string, (w: World, s: SessionInfo, b: Browser) => Promise<unknown>][] = [
    [
      'a password change',
      (w, s, b) => w.password.changePassword(b.context(), s, { newPassword: NEW_PASSWORD }),
    ],
    ['a password removal', (w, s) => w.password.removePassword(s)],
    [
      'an email change',
      async (w, s, b) => {
        const change = createEmailChange(w.config, {
          db: h.db,
          authDb: h.authDb,
          logger: loggerFor(h),
          mailer: w.mail.mailer,
        });
        const started = await change.startEmailChange(b.context(), s, {
          newEmail: address('moved'),
        });
        if (!started.ok) throw started.error;
        b.apply(started.value.setCookies);
        await started.value.send();
        const sent = w.mail.sent.at(-1);
        if (sent === undefined) throw new Error('no change mail');
        const done = await change.completeEmailChange(b.context(), s, {
          challenge: formatChallengeId(sent.challengeId),
          code: sent.code,
        });
        if (!done.ok) throw done.error;
      },
    ],
    [
      'a provider unlink',
      async (w, s) => {
        await h.sql(
          `insert into app.identities (user_id, provider, provider_subject, provider_email_normalized) values ('${s.userId}', 'github', 'u${String((n += 1))}', 'x@example.com');`,
        );
        const done = await w.oauth.unlinkIdentity(s, { provider: 'github' });
        if (!done.ok) throw done.error;
      },
    ],
    ['sign out everywhere', (w, s) => w.sessions.signOutEverywhere(s)],
    [
      'sign out everywhere else',
      async (w, s, b) => {
        const done = await w.sessions.signOutOtherSessions(s, b.context());
        if (!done.ok) throw done.error;
      },
    ],
    [
      'revoke-sessions',
      async (_w, s) => {
        const operator = createOperatorSessions({
          db: h.db,
          authDb: h.authDb,
          logger: loggerFor(h),
        });
        const email = (await h.sql(`select email from app.users where id = '${s.userId}';`)).trim();
        const done = await operator.revokeForEmail(email);
        if (!done.ok) throw done.error;
      },
    ],
  ];

  it.each(actions)('%s deletes the challenge', async (_name, act) => {
    const w = world();
    const c = await challenged(w, 'act');
    expect(await challengesOf(h, c.userId)).toBe(1);
    const s = await signedInSession(w, c.userId);
    await act(w, s, newBrowser());
    expect(await challengesOf(h, c.userId)).toBe(0);
    const late = await pass(w, c.b, 'recovery_code', c.codes[0] ?? '');
    expect(!late.ok && late.error.code).toBe('AUTH_FACTOR_CHALLENGE_EXPIRED');
  });

  it('a replaced challenge is not spent; the owner signing in again finishes', async () => {
    const w = world();
    const c = await challenged(w, 'replaced');
    const again = newBrowser();
    const second = await emailCode(w, again, c.email);
    if (!second.ok) throw second.error;
    gated(second.value, again);
    const old = await pass(w, c.b, 'recovery_code', c.codes[0] ?? '');
    expect(!old.ok && old.error.code).toBe('AUTH_FACTOR_CHALLENGE_EXPIRED');
    expect(await unusedCodesOf(h, c.userId)).toBe(10);
    const right = await pass(w, again, 'recovery_code', c.codes[0] ?? '');
    if (!right.ok) throw right.error;
  });

  it('an abandoned challenge keeps the old session; a passed one retires it', async () => {
    const w = world();
    const p = await person(w, 'abandon');
    const b = newBrowser();
    const first = await emailCode(w, b, p.email);
    if (!first.ok) throw first.error;
    b.apply(asSignedIn(first.value).setCookies);
    const oldCookie = b.cookies.get(w.config.cookies.session);
    const codes = await enroll(h, p.userId, w.config);
    const second = await emailCode(w, b, p.email);
    if (!second.ok) throw second.error;
    gated(second.value, b);
    expect(await w.sessions.resolveSession(oldCookie)).not.toBeNull();
    const right = await pass(w, b, 'recovery_code', codes[0] ?? '');
    if (!right.ok) throw right.error;
    expect(await w.sessions.resolveSession(oldCookie)).toBeNull();
    expect(await sessionsOf(h, p.userId)).toBe(1);
  });

  it('a challenge for an invitation carries its return path through to the end', async () => {
    const w = world();
    const p = await person(w, 'invite');
    const codes = await enroll(h, p.userId, w.config);
    const b = newBrowser();
    const started = await w.email.startEmailSignIn(b.context(), {
      email: p.email,
      returnTo: '/invite/accept',
    });
    if (!started.ok) throw started.error;
    b.apply(started.value.setCookies);
    await started.value.send();
    const sent = w.mail.sent.find((m) => m.to === p.email);
    const done = await w.email.verifyEmailCode(b.context(), { code: sent?.code ?? '' });
    if (!done.ok) throw done.error;
    gated(done.value, b);
    const right = await pass(w, b, 'recovery_code', codes[0] ?? '');
    if (!right.ok) throw right.error;
    expect(right.value.returnTo).toBe('/invite/accept');
  });
});

describeWithStack('the lock rule against enrolment', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  // Enrolment as #321 will write it: the exclusive lock, the row, and every other session
  // ended, held open until the test lets it commit.
  async function enrolling(w: World, userId: UserId, keep: string | null) {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const taken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const done = withUser(h.db, { userId }, async (tx) => {
      await lockFactor(tx, userId, 'exclusive');
      locked();
      await held;
      const sealed = w.config.totp.sealer?.seal(Buffer.alloc(20, 4), { userId });
      if (sealed === undefined) throw new Error('no sealer');
      await tx
        .insertInto('totp_credentials')
        .values({
          user_id: userId,
          key_id: sealed.keyId,
          secret_nonce: sealed.nonce,
          secret_sealed: sealed.sealed,
          confirmed_at: new Date(),
          last_used_step: null,
          last_used_at: null,
          failed_attempts: 0,
        })
        .execute();
      await tx
        .deleteFrom('sessions')
        .where('user_id', '=', sql<string>`app.current_user_id()`)
        .$if(keep !== null, (q) => q.where('id', '<>', keep ?? ''))
        .execute();
    });
    await taken;
    return { release, done };
  }

  it('a sign in racing enrolment leaves no unverified session', async () => {
    const w = world();
    const p = await person(w, 'racesignin');
    const enrol = await enrolling(w, p.userId, null);
    const racing = w.sessions.startSession(newBrowser().context(), {
      userId: p.userId,
      method: 'email',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    enrol.release();
    await enrol.done;
    const started = await racing;
    expect(started.kind).toBe('factor_required');
    expect(await sessionsOf(h, p.userId)).toBe(0);
  });

  it('sign out everywhere else racing enrolment leaves no unverified session', async () => {
    const w = world();
    const p = await person(w, 'raceothers');
    const enroller = asSignedIn(
      await w.sessions.startSession(newBrowser().context(), { userId: p.userId, method: 'email' }),
    ).session;
    const other = asSignedIn(
      await w.sessions.startSession(newBrowser().context(), { userId: p.userId, method: 'email' }),
    ).session;
    const enrol = await enrolling(w, p.userId, enroller.sessionId);
    const racing = w.sessions.signOutOtherSessions(other, newBrowser().context());
    await new Promise((resolve) => setTimeout(resolve, 100));
    enrol.release();
    await enrol.done;
    const rotated = await racing;
    expect(!rotated.ok && rotated.error.code).toBe('AUTH_SESSION_INVALID');
    expect((await h.sql(`select id from app.sessions where user_id = '${p.userId}';`)).trim()).toBe(
      enroller.sessionId,
    );
  });
});

async function requestReset(w: World, b: Browser, email: string) {
  const started = await w.password.startPasswordReset(b.context(), { email });
  if (!started.ok) throw started.error;
  b.apply(started.value.setCookies);
  await started.value.send();
  const sent = w.mail.sent.filter((m) => m.to === email).at(-1);
  if (sent === undefined) throw new Error('no reset mail');
  return { code: sent.code };
}

async function trip(w: World, account: Parameters<World['fakes']['approve']>[1], jar = new Jar()) {
  const started = await w.oauth.startOAuth(jar.context(), {
    provider: account.provider,
    purpose: 'sign_in',
  });
  if (!started.ok) throw started.error;
  jar.apply(started.value.setCookies);
  const { query } = w.fakes.approve(started.value.redirectTo, account);
  const done = await w.oauth.completeOAuth(jar.context(), { provider: account.provider, query });
  if (done.ok) {
    jar.apply(done.value.setCookies);
    if ('send' in done.value) await done.value.send();
  }
  return { jar, done };
}
