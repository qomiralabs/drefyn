import { withAuth, withUser } from '@drefyn/db';
import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { createEmailSignIn, parsePhc, type AuthConfig } from '../../src/index.ts';
import { createTestAuthMailer } from '../../src/testing.ts';
import { expectSameWire, newBrowser, requestCode, wireOf } from './support/email.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';
import {
  BIGGER,
  SMALL,
  hasherAt,
  heldHasher,
  insideWindow,
  insideWindowTimeout,
  loggerFor,
  passwordConfig,
  passwordFlow,
  personWithPassword,
  phcOf,
  sessionsOf,
  signInFrom,
} from './support/passwords.ts';

const PASSWORD = 'a long and quiet sentence';
const fresh = harness();
const tiny = harness({ app: 1, auth: 1 });
let h: Harness;

describeWithStack('password sign in against Postgres', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  it('a set password signs in, with a password session and a known device', async () => {
    const flow = passwordFlow(h, passwordConfig());
    const { email } = await personWithPassword(h, flow, PASSWORD);
    expect(parsePhc(await phcOf(h, email), SMALL)?.params).toEqual(SMALL);
    const b = newBrowser();
    const result = await signInFrom(flow, b, email, PASSWORD);
    if (!result.ok) throw result.error;
    expect(result.value.session.method).toBe('password');
    expect(await sessionsOf(h, email)).toBe('1');
    const devices = await h.sql(
      `select count(*) || '|' || min(d.user_agent_family) from app.known_devices d join app.users u on u.id = d.user_id where u.email_normalized = '${email}';`,
    );
    expect(devices).toBe('1|Other');
    expect(result.value.setCookies.map((c) => c.name)).toContain(flow.config.cookies.device);
  });

  it('unknown address, no password, wrong password and closed sign up give identical answers', async () => {
    const config = passwordConfig();
    const flow = passwordFlow(h, config);
    const { email } = await personWithPassword(h, flow, PASSWORD);
    const noPassword = `nopw${String(Date.now())}@example.com`;
    await h.user(noPassword);
    const closed = passwordFlow(h, passwordConfig({ DREFYN_AUTH_SIGNUP: 'closed' }));
    const answers = [
      wireOf(await signInFrom(flow, newBrowser(), 'nobody-here@example.com', PASSWORD)),
      wireOf(await signInFrom(flow, newBrowser(), noPassword, PASSWORD)),
      wireOf(await signInFrom(flow, newBrowser(), email, 'not the right sentence')),
      wireOf(await signInFrom(closed, newBrowser(), 'nobody-here@example.com', PASSWORD)),
      wireOf(await signInFrom(closed, newBrowser(), email, 'not the right sentence')),
    ];
    for (const answer of answers) expectSameWire(answer, answers[0] ?? answer);
    expect(answers[0]?.shape).toContain('AUTH_CREDENTIALS_INVALID');
    expect(answers.every((a) => !a.ok)).toBe(true);
  });

  describe('rehash', () => {
    it('happens exactly when the parameters differ', async () => {
      const small = passwordFlow(h, passwordConfig(), hasherAt(SMALL));
      const { email } = await personWithPassword(h, small, PASSWORD);
      const before = await phcOf(h, email);
      const same = await signInFrom(small, newBrowser(), email, PASSWORD);
      expect(same.ok).toBe(true);
      expect(await phcOf(h, email)).toBe(before);
      const raised = passwordFlow(h, passwordConfig(), hasherAt(BIGGER));
      const moved = await signInFrom(raised, newBrowser(), email, PASSWORD);
      expect(moved.ok).toBe(true);
      const after = await phcOf(h, email);
      expect(after).not.toBe(before);
      expect(parsePhc(after, SMALL)?.params).toEqual(BIGGER);
      await expect(hasherAt(BIGGER).verify(after, PASSWORD)).resolves.toBe(true);
      // A wrong password at the old parameters changes nothing.
      const { email: other } = await personWithPassword(h, small, PASSWORD);
      const otherBefore = await phcOf(h, other);
      await signInFrom(raised, newBrowser(), other, 'not the right sentence');
      expect(await phcOf(h, other)).toBe(otherBefore);
    });

    it('two parallel sign ins both succeed and rehash once', async () => {
      const small = passwordFlow(h, passwordConfig(), hasherAt(SMALL));
      const { email } = await personWithPassword(h, small, PASSWORD);
      const before = await phcOf(h, email);
      const raised = passwordFlow(h, passwordConfig(), hasherAt(BIGGER));
      for (let round = 0; round < 5; round += 1) {
        await h.sql(
          `update app.password_credentials c set phc = '${before}' from app.users u where u.id = c.user_id and u.email_normalized = '${email}';`,
        );
        const [a, b] = await Promise.all([
          signInFrom(raised, newBrowser(), email, PASSWORD),
          signInFrom(raised, newBrowser(), email, PASSWORD),
        ]);
        expect(a.ok && b.ok).toBe(true);
        const after = await phcOf(h, email);
        expect(parsePhc(after, SMALL)?.params).toEqual(BIGGER);
        await expect(hasherAt(BIGGER).verify(after, PASSWORD)).resolves.toBe(true);
      }
      expect(await sessionsOf(h, email)).toBe('10');
    });

    it('never overwrites a password changed while the rehash was being computed', async () => {
      const small = passwordFlow(h, passwordConfig(), hasherAt(SMALL));
      const { email, session } = await personWithPassword(h, small, PASSWORD);
      const held = heldHasher(hasherAt(BIGGER));
      const raised = passwordFlow(h, passwordConfig(), held.hasher);
      const pending = signInFrom(raised, newBrowser(), email, PASSWORD);
      await held.inside;
      const changed = await hasherAt(SMALL).hash('the new password after a change');
      await withUser(h.db, { userId: session.userId }, (tx) =>
        tx
          .updateTable('password_credentials')
          .set({ phc: changed, updated_at: sql<Date>`now()` })
          .where('user_id', '=', session.userId)
          .execute(),
      );
      held.release();
      const result = await pending;
      expect(!result.ok && result.error.code).toBe('AUTH_CREDENTIALS_INVALID');
      expect(await phcOf(h, email)).toBe(changed);
    });
  });

  it('holds no database connection while hashing, with pools of one', async () => {
    const t = await tiny();
    const held = heldHasher(hasherAt(SMALL));
    const config = passwordConfig();
    const setup = passwordFlow(t, config);
    const { email, session } = await personWithPassword(t, setup, PASSWORD);
    const flow = passwordFlow(t, config, held.hasher);
    const pending = signInFrom(flow, newBrowser(), email, PASSWORD);
    await held.inside;
    // Both pools have one connection; these finish only if the flow released it.
    const within = <T>(work: Promise<T>) =>
      Promise.race([
        work,
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            reject(new Error('a connection is held during the hash'));
          }, 5_000),
        ),
      ]);
    await within(withAuth(t.authDb, (tx) => sql`select 1`.execute(tx)));
    await within(withUser(t.db, { userId: session.userId }, (tx) => sql`select 1`.execute(tx)));
    held.release();
    const result = await pending;
    expect(result.ok).toBe(true);
  });

  it('a reset between the read and the session leaves no session for the sign in in flight', async () => {
    const small = passwordFlow(h, passwordConfig(), hasherAt(SMALL));
    const { email, session } = await personWithPassword(h, small, PASSWORD);
    const held = heldHasher(hasherAt(SMALL));
    const flow = passwordFlow(h, passwordConfig(), held.hasher);
    const pending = signInFrom(flow, newBrowser(), email, PASSWORD);
    await held.inside;
    // What a reset does: a new hash, and every session of the person gone.
    const reset = await hasherAt(SMALL).hash('chosen after the reset code');
    await withUser(h.db, { userId: session.userId }, async (tx) => {
      await tx
        .updateTable('password_credentials')
        .set({ phc: reset })
        .where('user_id', '=', session.userId)
        .execute();
      await tx.deleteFrom('sessions').where('user_id', '=', session.userId).execute();
    });
    held.release();
    const result = await pending;
    expect(!result.ok && result.error.code).toBe('AUTH_CREDENTIALS_INVALID');
    expect(await sessionsOf(h, email)).toBe('0');
    expect(await sessionsOf(h, email, 'email')).toBe('0');
  });

  it(
    '200 parallel attempts against one address never let more than the limit through',
    async () => {
      const config = passwordConfig({
        DREFYN_AUTH_RATE_PASSWORD_FAIL: '10/15m',
        DREFYN_AUTH_RATE_PASSWORD_FAIL_IP: '1000/10m',
      });
      const flow = passwordFlow(h, config);
      const { email } = await personWithPassword(h, passwordFlow(h, passwordConfig()), PASSWORD);
      await insideWindow(h, 900, 60);
      const b = newBrowser();
      const form = flow.signIn.passwordForm(b.context());
      b.apply(form.setCookies);
      const results = await Promise.all(
        Array.from({ length: 200 }, (_, i) =>
          flow.signIn.signInWithPassword(b.context(), {
            email,
            password: i % 2 === 0 ? PASSWORD : 'not the right sentence',
            csrf: form.csrf,
          }),
        ),
      );
      const through = results.filter((r) => r.ok || r.error.code !== 'AUTH_RATE_LIMITED');
      expect(through.length).toBeLessThanOrEqual(10);
      expect(through.length).toBeGreaterThan(0);
      expect(results.filter((r) => !r.ok && r.error.code === 'AUTH_RATE_LIMITED').length).toBe(
        200 - through.length,
      );
    },
    insideWindowTimeout(60),
  );

  it(
    'while the password bucket for an address is full, that person still signs in by email code',
    async () => {
      const config = passwordConfig({
        DREFYN_AUTH_RATE_PASSWORD_FAIL: '10/15m',
        DREFYN_AUTH_SIGNUP: 'closed',
      });
      const flow = passwordFlow(h, config);
      const { email } = await personWithPassword(h, passwordFlow(h, passwordConfig()), PASSWORD);
      await insideWindow(h, 900, 60);
      // An attacker fills the bucket from two /64 prefixes, with the real limiter.
      for (let i = 0; i < 10; i += 1) {
        await signInFrom(flow, newBrowser(`2001:db8:${String(i % 2)}::1`), email, 'guessing guess');
      }
      // The person, from their own browser and address: a right and a wrong password get the
      // same refusal while the bucket is full.
      const person = newBrowser('192.0.2.77');
      const right = await signInFrom(flow, person, email, PASSWORD);
      const wrong = await signInFrom(flow, person, email, 'not the right sentence');
      expect(!right.ok && right.error.code).toBe('AUTH_RATE_LIMITED');
      expectSameWire(wireOf(right), wireOf(wrong));
      expect(await sessionsOf(h, email)).toBe('0');
      // Then by code, from that same browser and address. Setting the password left one email
      // session behind.
      const emailSessions = Number(await sessionsOf(h, email, 'email'));
      const mail = createTestAuthMailer();
      const emailFlow = {
        config,
        mail,
        sessions: flow.sessions,
        signIn: createEmailSignIn(config, {
          db: h.db,
          authDb: h.authDb,
          logger: loggerFor(h),
          mailer: mail.mailer,
          sessions: flow.sessions,
        }),
      };
      const sent = await requestCode(emailFlow, person, email);
      if (sent === null) throw new Error('no code was mailed');
      const verified = await emailFlow.signIn.verifyEmailCode(person.context(), sent);
      expect(verified.ok).toBe(true);
      expect(Number(await sessionsOf(h, email, 'email'))).toBe(emailSessions + 1);
    },
    insideWindowTimeout(60),
  );

  describe('the pre sign in binding, on the database', () => {
    // The person's own address bucket, so other tests' rows and window cleanup do not matter.
    const countsOf = (config: AuthConfig, email: string) => {
      const key = config.keys.mac('rate', ['password_fail', email]).toString('hex');
      return h.sql(
        `select coalesce(sum(count), 0) from app.auth_rate_limits where bucket = 'password_fail' and key_hmac = '\\x${key}';`,
      );
    };

    it('refused posts reserve no counts, read no credential and create no session; a valid pair succeeds', async () => {
      const flow = passwordFlow(h, passwordConfig());
      const { email } = await personWithPassword(h, flow, PASSWORD);
      const checks: (string | null)[] = [];
      const watched = passwordFlow(h, flow.config, {
        ...flow.hasher,
        check: (phc, password) => {
          checks.push(phc);
          return flow.hasher.check(phc, password);
        },
      });
      const holder = newBrowser();
      const form = watched.signIn.passwordForm(holder.context());
      holder.apply(form.setCookies);
      const other = newBrowser();
      other.apply(watched.signIn.passwordForm(other.context()).setCookies);
      const otherForm = watched.signIn.passwordForm(other.context());
      const preName = flow.config.cookies.pre;
      const cases = [
        ['no pre cookie', newBrowser().context(), form.csrf],
        [
          'a malformed cookie',
          newBrowser().context({ cookies: new Map([[preName, 'x']]) }),
          form.csrf,
        ],
        ['no field', holder.context(), ''],
        ['a forged field', holder.context(), 'A'.repeat(43)],
        ["another browser's field", holder.context(), otherForm.csrf],
      ] as const;
      const before = await countsOf(flow.config, email);
      for (const [name, context, csrf] of cases) {
        const result = await watched.signIn.signInWithPassword(context, {
          email,
          password: PASSWORD,
          csrf,
        });
        expect(!result.ok && result.error.code, name).toBe('AUTH_ORIGIN_REFUSED');
      }
      expect(await countsOf(flow.config, email)).toBe(before);
      expect(checks).toEqual([]);
      expect(await sessionsOf(h, email)).toBe('0');
      const good = await watched.signIn.signInWithPassword(holder.context(), {
        email,
        password: PASSWORD,
        csrf: form.csrf,
      });
      expect(good.ok).toBe(true);
      expect(Number(await countsOf(flow.config, email))).toBe(Number(before) + 1);
      expect(await sessionsOf(h, email)).toBe('1');
    });
  });

  it('setPassword refuses to replace a password, and a second tab racing the first loses cleanly', async () => {
    const flow = passwordFlow(h, passwordConfig());
    const { session } = await personWithPassword(h, flow, PASSWORD);
    const again = await flow.signIn.setPassword(session, { newPassword: 'another long sentence' });
    expect(!again.ok && again.error.code).toBe('AUTH_FORBIDDEN');
    const userId = await h.user();
    const started = await flow.sessions.startSession(newBrowser().context(), {
      userId,
      method: 'email',
    });
    const [a, b] = await Promise.all([
      flow.signIn.setPassword(started.session, { newPassword: 'first tab sentence here' }),
      flow.signIn.setPassword(started.session, { newPassword: 'second tab sentence here' }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });
});
