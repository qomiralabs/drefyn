import { withUser } from '@drefyn/db';
import { sql } from 'kysely';
import { beforeAll, expect, it } from 'vitest';
import {
  createEmailSignIn,
  createPasswordAccount,
  type AuthConfig,
  type BreachedPasswordCheck,
  type SessionInfo,
} from '../../src/index.ts';
import { createTestAuthMailer, type TestAuthMailer } from '../../src/testing.ts';
import { expectSameWire, newBrowser, wireOf, type Browser } from './support/email.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';
import {
  SMALL,
  hasherAt,
  heldHasher,
  loggerFor,
  passwordConfig,
  passwordFlow,
  personWithPassword,
  phcOf,
  sessionsOf,
  signInFrom,
} from './support/passwords.ts';

const PASSWORD = 'a long and quiet sentence';
const NEW_PASSWORD = 'a fresh sentence after the reset';
const fresh = harness();
let h: Harness;

let n = 0;
const address = (label: string) => `${label}${String((n += 1))}@reset.example.com`;

function accountFlow(
  config: AuthConfig,
  mail: TestAuthMailer = createTestAuthMailer(),
  breachedPasswords?: BreachedPasswordCheck,
) {
  const flow = passwordFlow(h, config, hasherAt(SMALL), { mailer: mail.mailer });
  const account = createPasswordAccount(config, {
    db: h.db,
    authDb: h.authDb,
    logger: loggerFor(h),
    mailer: mail.mailer,
    sessions: flow.sessions,
    hasher: flow.hasher,
    ...(breachedPasswords === undefined ? {} : { breachedPasswords }),
  });
  const emailSignIn = createEmailSignIn(config, {
    db: h.db,
    authDb: h.authDb,
    logger: loggerFor(h),
    mailer: mail.mailer,
    sessions: flow.sessions,
  });
  return { ...flow, account, emailSignIn, mail };
}

type AccountFlow = ReturnType<typeof accountFlow>;

// Starts a reset from a browser and returns what the mail said, or null when none was sent.
async function requestReset(flow: AccountFlow, b: Browser, email: string) {
  const before = flow.mail.sent.length;
  const started = await flow.account.startPasswordReset(b.context(), { email });
  if (!started.ok) throw started.error;
  b.apply(started.value.setCookies);
  await started.value.send();
  const sent = flow.mail.sent.slice(before).find((m) => m.to === email);
  if (sent === undefined) return null;
  return { code: sent.code, challenge: sent.link.hash.slice(1, 27) };
}

const allSessionsOf = (email: string) =>
  h.sql(
    `select count(*) from app.sessions s join app.users u on u.id = s.user_id where u.email_normalized = '${email}';`,
  );
const attemptsOf = (email: string) =>
  h.sql(
    `select coalesce(sum(attempts), 0) from app.email_challenges where email_normalized = '${email}' and purpose = 'password_reset';`,
  );

// An earlier sign in, so the 15 minute window has passed.
const ageSession = (s: SessionInfo) =>
  h.sql(
    `update app.sessions set authenticated_at = now() - interval '20 minutes' where id = '${s.sessionId}';`,
  );

describeWithStack('password reset, change and removal against Postgres', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  it('reset start gives the same body and cookies for known and unknown addresses', async () => {
    const flow = accountFlow(passwordConfig());
    const { email } = await personWithPassword(h, flow, PASSWORD);
    const noPassword = address('nopw');
    await h.user(noPassword);
    const answers = [];
    for (const target of [email, noPassword, address('nobody')]) {
      const b = newBrowser();
      answers.push(wireOf(await flow.account.startPasswordReset(b.context(), { email: target })));
      const first = await flow.account.startPasswordReset(b.context(), { email: target });
      if (first.ok) b.apply(first.value.setCookies);
      answers.push(wireOf(await flow.account.startPasswordReset(b.context(), { email: target })));
    }
    const freshOnes = answers.filter((_, i) => i % 2 === 0);
    const holding = answers.filter((_, i) => i % 2 === 1);
    for (const a of freshOnes) expectSameWire(a, freshOnes[0] ?? a);
    for (const a of holding) expectSameWire(a, holding[0] ?? a);
    expect(answers.every((a) => a.ok)).toBe(true);
  });

  it('a reset code tried in another browser is refused without using an attempt', async () => {
    const flow = accountFlow(passwordConfig());
    const { email } = await personWithPassword(h, flow, PASSWORD);
    const mine = newBrowser();
    const sent = await requestReset(flow, mine, email);
    if (sent === null) throw new Error('no reset mail');
    const before = await attemptsOf(email);
    const thief = newBrowser();
    thief.apply(flow.signIn.passwordForm(thief.context()).setCookies);
    const result = await flow.account.completePasswordReset(thief.context(), {
      ...sent,
      newPassword: NEW_PASSWORD,
    });
    expect(!result.ok && result.error.code).toBe('AUTH_CHALLENGE_BINDING');
    expect(await attemptsOf(email)).toBe(before);
    // The person's own browser still has all five tries and finishes the reset.
    const own = await flow.account.completePasswordReset(mine.context(), {
      ...sent,
      newPassword: NEW_PASSWORD,
    });
    expect(own.ok).toBe(true);
  });

  it('a completed reset deletes every other session, starts one, and sends a notice', async () => {
    const flow = accountFlow(passwordConfig());
    const { email } = await personWithPassword(h, flow, PASSWORD);
    // Two more sessions on other browsers.
    await signInFrom(flow, newBrowser(), email, PASSWORD);
    await signInFrom(flow, newBrowser(), email, PASSWORD);
    expect(await allSessionsOf(email)).toBe('3');
    const b = newBrowser();
    const sent = await requestReset(flow, b, email);
    if (sent === null) throw new Error('no reset mail');
    const result = await flow.account.completePasswordReset(b.context(), {
      ...sent,
      newPassword: NEW_PASSWORD,
    });
    if (!result.ok) throw result.error;
    b.apply(result.value.setCookies);
    expect(await allSessionsOf(email)).toBe('1');
    const resolved = await flow.sessions.resolveSession(b.cookies.get(flow.config.cookies.session));
    expect(resolved?.sessionId).toBe(result.value.session.sessionId);
    // The fresh session counts as a recent sign in.
    expect((await flow.sessions.requireRecentAuth(result.value.session)).ok).toBe(true);
    const old = await signInFrom(flow, newBrowser(), email, PASSWORD);
    expect(!old.ok && old.error.code).toBe('AUTH_CREDENTIALS_INVALID');
    const next = await signInFrom(flow, newBrowser(), email, NEW_PASSWORD);
    expect(next.ok).toBe(true);
    await result.value.send?.();
    expect(flow.mail.notices.filter((m) => m.to === email).map((m) => m.notice.kind)).toContain(
      'password_reset',
    );
  });

  it('a proved reset code without a saved password creates no session', async () => {
    const flow = accountFlow(passwordConfig());
    const { email } = await personWithPassword(h, flow, PASSWORD);
    const before = await allSessionsOf(email);
    const b = newBrowser();
    const sent = await requestReset(flow, b, email);
    if (sent === null) throw new Error('no reset mail');
    // The link opens the choose a password step and signs nobody in.
    const opened = await flow.emailSignIn.verifyLinkCode(b.context(), null, sent);
    expect(opened.ok && opened.value.kind).toBe('choose_password');
    // Typed into the sign in form, it is not a sign in code.
    const typed = await flow.emailSignIn.verifyEmailCode(b.context(), { code: sent.code });
    expect(typed.ok).toBe(false);
    // A refused password leaves the code proved but nothing saved.
    const weak = await flow.account.completePasswordReset(b.context(), {
      ...sent,
      newPassword: 'aaaaaaaaaaaaaaaaaaaa',
    });
    expect(!weak.ok && weak.error.code).toBe('AUTH_PASSWORD_WEAK');
    expect(await allSessionsOf(email)).toBe(before);
    expect(b.cookies.has(flow.config.cookies.session)).toBe(false);
  });

  it('a reset during an in flight password sign in leaves no session for that sign in', async () => {
    const setup = accountFlow(passwordConfig());
    const { email } = await personWithPassword(h, setup, PASSWORD);
    const held = heldHasher(hasherAt(SMALL));
    const attacker = passwordFlow(h, setup.config, held.hasher);
    const pending = signInFrom(attacker, newBrowser(), email, PASSWORD);
    await held.inside;
    const b = newBrowser();
    const sent = await requestReset(setup, b, email);
    if (sent === null) throw new Error('no reset mail');
    const reset = await setup.account.completePasswordReset(b.context(), {
      ...sent,
      newPassword: NEW_PASSWORD,
    });
    if (!reset.ok) throw reset.error;
    held.release();
    const result = await pending;
    expect(!result.ok && result.error.code).toBe('AUTH_CREDENTIALS_INVALID');
    expect(await sessionsOf(h, email)).toBe('0');
    expect(await allSessionsOf(email)).toBe('1');
  });

  it('change and removal between the hash read and the session leave no session either', async () => {
    for (const kind of ['change', 'remove'] as const) {
      const setup = accountFlow(passwordConfig());
      const { email, session } = await personWithPassword(h, setup, PASSWORD);
      const held = heldHasher(hasherAt(SMALL));
      const attacker = passwordFlow(h, setup.config, held.hasher);
      const pending = signInFrom(attacker, newBrowser(), email, PASSWORD);
      await held.inside;
      const done =
        kind === 'change'
          ? await setup.account.changePassword(newBrowser().context(), session, {
              newPassword: NEW_PASSWORD,
            })
          : await setup.account.removePassword(session);
      if (!done.ok) throw done.error;
      held.release();
      const result = await pending;
      expect(!result.ok && result.error.code, kind).toBe('AUTH_CREDENTIALS_INVALID');
      expect(await sessionsOf(h, email), kind).toBe('0');
    }
  });

  it('session creation waits on a reset holding the row, then finds the hash moved', async () => {
    const setup = accountFlow(passwordConfig());
    const { email, session } = await personWithPassword(h, setup, PASSWORD);
    const replacement = await hasherAt(SMALL).hash(NEW_PASSWORD);
    let commit: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (commit = resolve));
    let locked: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    // A reset that has written the new hash and not yet committed.
    const reset = withUser(h.db, { userId: session.userId }, async (tx) => {
      await tx
        .updateTable('password_credentials')
        .set({ phc: replacement, updated_at: sql<Date>`now()` })
        .where('user_id', '=', session.userId)
        .execute();
      locked();
      await gate;
    });
    await holding;
    const pending = signInFrom(setup, newBrowser(), email, PASSWORD);
    // Wait until the sign in's last step is blocked on the row lock.
    for (let i = 0; i < 200; i += 1) {
      const waiting = await h.sql(
        `select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock';`,
      );
      if (waiting !== '0') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    commit();
    await reset;
    const result = await pending;
    expect(!result.ok && result.error.code).toBe('AUTH_CREDENTIALS_INVALID');
    expect(await sessionsOf(h, email)).toBe('0');
  });

  it('change without the current password outside 15 minutes needs a recent sign in', async () => {
    const flow = accountFlow(passwordConfig());
    const { email, session } = await personWithPassword(h, flow, PASSWORD);
    await ageSession(session);
    const refused = await flow.account.changePassword(newBrowser().context(), session, {
      newPassword: NEW_PASSWORD,
    });
    expect(!refused.ok && refused.error.code).toBe('AUTH_RECENT_AUTH_REQUIRED');
    // With the current password it goes through, and ends the other sessions.
    await signInFrom(flow, newBrowser(), email, PASSWORD);
    const changed = await flow.account.changePassword(newBrowser().context(), session, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    if (!changed.ok) throw changed.error;
    expect(changed.value.revoked).toBe(1);
    expect(await allSessionsOf(email)).toBe('1');
    await changed.value.send();
    expect(flow.mail.notices.filter((m) => m.to === email).map((m) => m.notice.kind)).toContain(
      'password_changed',
    );
  });

  it('removing the last sign in method is refused, and allowed while another remains', async () => {
    const off = accountFlow(passwordConfig({ DREFYN_AUTH_EMAIL: 'off' }));
    const { email, session } = await personWithPassword(h, off, PASSWORD);
    const refused = await off.account.removePassword(session);
    expect(!refused.ok && refused.error.code).toBe('AUTH_FORBIDDEN');
    expect(
      await h.sql(
        `select count(*) from app.password_credentials c join app.users u on u.id = c.user_id where u.email_normalized = '${email}';`,
      ),
    ).toBe('1');
    const on = accountFlow(passwordConfig());
    const removed = await on.account.removePassword(session);
    if (!removed.ok) throw removed.error;
    await removed.value.send();
    expect(on.mail.notices.map((m) => m.notice.kind)).toEqual(['password_removed']);
    const signIn = await signInFrom(on, newBrowser(), email, PASSWORD);
    expect(!signIn.ok && signIn.error.code).toBe('AUTH_CREDENTIALS_INVALID');
  });

  it('a first password set sends the password set notice', async () => {
    const mail = createTestAuthMailer();
    const flow = accountFlow(passwordConfig(), mail);
    const userId = await h.user(address('first'));
    const started = await flow.sessions.startSession(newBrowser().context(), {
      userId,
      method: 'email',
    });
    const set = await flow.signIn.setPassword(started.session, { newPassword: PASSWORD });
    if (!set.ok) throw set.error;
    await set.value.send();
    expect(mail.notices.map((m) => m.notice.kind)).toEqual(['password_set']);
  });

  it('change and reset refuse a listed password through the same step as set', async () => {
    const listed: BreachedPasswordCheck = { isBreached: () => Promise.resolve(true) };
    const flow = accountFlow(passwordConfig(), createTestAuthMailer(), listed);
    const { email, session } = await personWithPassword(h, flow, PASSWORD);
    const before = await phcOf(h, email);
    const changed = await flow.account.changePassword(newBrowser().context(), session, {
      newPassword: NEW_PASSWORD,
    });
    expect(!changed.ok && changed.error.code).toBe('AUTH_PASSWORD_BREACHED');
    const b = newBrowser();
    const sent = await requestReset(flow, b, email);
    if (sent === null) throw new Error('no reset mail');
    const reset = await flow.account.completePasswordReset(b.context(), {
      ...sent,
      newPassword: NEW_PASSWORD,
    });
    expect(!reset.ok && reset.error.code).toBe('AUTH_PASSWORD_BREACHED');
    expect(await phcOf(h, email)).toBe(before);
    expect(b.cookies.has(flow.config.cookies.session)).toBe(false);
  });

  it('a check that cannot answer lets the change through and records it', async () => {
    const silent: BreachedPasswordCheck = { isBreached: () => Promise.resolve(null) };
    const flow = accountFlow(passwordConfig(), createTestAuthMailer(), silent);
    const { email, session } = await personWithPassword(h, flow, PASSWORD);
    const before = await phcOf(h, email);
    const changed = await flow.account.changePassword(newBrowser().context(), session, {
      newPassword: NEW_PASSWORD,
    });
    if (!changed.ok) throw changed.error;
    expect(await phcOf(h, email)).not.toBe(before);
    expect(h.logs.map((l) => l.event)).toContain('auth.breach_check_unavailable');
    const next = await signInFrom(flow, newBrowser(), email, NEW_PASSWORD);
    expect(next.ok).toBe(true);
  });
});
