import { randomBytes } from 'node:crypto';
import { newId, withAuth, withUser } from '@drefyn/db';
import { sql } from 'kysely';
import { beforeAll, expect, it } from 'vitest';
import {
  createCodeIssuer,
  createEmailChange,
  formatChallengeId,
  type EmailChange,
} from '../../src/index.ts';
import {
  configWith,
  expectSameWire,
  flowFor,
  newBrowser,
  requestCode,
  wireOf,
  wrongCode,
  type Browser,
  type Flow,
} from './support/email.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';

const fresh = harness();
const anyDate: unknown = expect.any(Date);
let h: Harness;
let flow: Flow;
let change: EmailChange;

const address = (tag: string) => `${tag}-${randomBytes(4).toString('hex')}@example.com`;

const logger = () => ({
  info(event: string, fields: Readonly<Record<string, string | number | boolean>>) {
    h.logs.push({ level: 'info', event, fields });
  },
  warn(event: string, fields: Readonly<Record<string, string | number | boolean>>) {
    h.logs.push({ level: 'warn', event, fields });
  },
});

async function signedIn(email = address('person')) {
  const user = await h.user(email);
  const b = newBrowser();
  const started = await flow.sessions.startSession(b.context(), { userId: user, method: 'email' });
  b.apply(started.setCookies);
  return { user, b, email, session: started.session, cookie: cookieOf(b) };
}

type Person = Awaited<ReturnType<typeof signedIn>>;

const cookieOf = (b: Browser) => b.cookies.get(h.config.cookies.session) ?? '';

// Starts a change, runs the deferred send, and returns what the mail said, if anything went.
async function startChange(p: Person, newEmail: string) {
  const before = flow.mail.sent.length;
  const result = await change.startEmailChange(p.b.context(), p.session, { newEmail });
  if (!result.ok) throw result.error;
  p.b.apply(result.value.setCookies);
  await result.value.send();
  const sent = flow.mail.sent.slice(before).find((m) => m.to === newEmail);
  if (sent === undefined) return null;
  return { code: sent.code, challenge: sent.link.hash.slice(1, 27), purpose: sent.purpose };
}

const addressOf = (user: string) =>
  h.sql(`select email || '|' || email_normalized from app.users where id = '${user}';`);

const age = (sessionId: string, minutes: number) =>
  h.sql(
    `update app.sessions set authenticated_at = now() - interval '${String(minutes)} minutes' where id = '${sessionId}';`,
  );

async function waitForLockWait(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const waiting = await h.sql(
      `select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock';`,
    );
    if (Number(waiting) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the change never waited on the sign up');
}

describeWithStack('email change against Postgres', () => {
  beforeAll(async () => {
    h = await fresh();
    flow = flowFor(h, configWith());
    change = createEmailChange(flow.config, {
      db: h.db,
      authDb: h.authDb,
      logger: logger(),
      mailer: flow.mail.mailer,
    });
  });

  it('changes the address end to end through both calls, and sign in follows it', async () => {
    const p = await signedIn();
    const next = address('moved');
    const mail = await startChange(p, next);
    expect(mail?.purpose).toBe('email_change');
    if (mail === null) throw new Error('no code was mailed');
    const done = await change.completeEmailChange(p.b.context(), p.session, mail);
    if (!done.ok) throw done.error;
    await done.value.send();
    expect(await addressOf(p.user)).toBe(`${next}|${next}`);
    await expect(flow.sessions.resolveSession(p.cookie)).resolves.toMatchObject({ email: next });
    const other = newBrowser();
    const code = await requestCode(flow, other, next);
    if (code === null) throw new Error('no sign in code for the new address');
    const signed = await flow.signIn.verifyEmailCode(other.context(), code);
    expect(signed.ok && signed.value.session.userId).toBe(p.user);
    // The old address now belongs to nobody, so in this mode it gets no code.
    expect(await requestCode(flow, newBrowser(), p.email)).toBeNull();
    const logged = JSON.stringify(h.logs);
    expect(logged).not.toContain(next);
    expect(logged).not.toContain(p.email);
  });

  it('start and completion each need a sign in within 15 minutes', async () => {
    const p = await signedIn();
    await age(p.session.sessionId, 16);
    const refused = await change.startEmailChange(p.b.context(), p.session, {
      newEmail: address('late'),
    });
    expect(!refused.ok && refused.error.code).toBe('AUTH_RECENT_AUTH_REQUIRED');

    await age(p.session.sessionId, 0);
    const next = address('later');
    const mail = await startChange(p, next);
    if (mail === null) throw new Error('no code was mailed');
    await age(p.session.sessionId, 16);
    const late = await change.completeEmailChange(p.b.context(), p.session, mail);
    expect(!late.ok && late.error.code).toBe('AUTH_RECENT_AUTH_REQUIRED');
    expect(await addressOf(p.user)).toBe(`${p.email}|${p.email}`);

    await age(p.session.sessionId, 14);
    const inTime = await change.completeEmailChange(p.b.context(), p.session, mail);
    expect(inTime.ok).toBe(true);
    expect(await addressOf(p.user)).toBe(`${next}|${next}`);
  });

  it('a taken address gets the same answer and no mail, and its code can never verify', async () => {
    const owner = await signedIn();
    const p = await signedIn();
    const free = address('free');
    const before = flow.mail.calls.length;
    const taken = await change.startEmailChange(p.b.context(), p.session, {
      newEmail: owner.email,
    });
    if (taken.ok) p.b.apply(taken.value.setCookies);
    const takenWire = wireOf(taken);
    const q = await signedIn();
    const freeWire = wireOf(
      await change.startEmailChange(q.b.context(), q.session, { newEmail: free }),
    );
    expectSameWire(takenWire, freeWire);
    expect(takenWire.ok).toBe(true);
    const calls = flow.mail.calls.slice(before);
    expect(calls.some((m) => m.to === owner.email)).toBe(false);

    // Even a right code fails: give the stored challenge a code the test knows.
    const id = await h.sql(
      `select id from app.email_challenges where purpose = 'email_change' and user_id = '${p.user}';`,
    );
    const code = '12345678';
    const hmac = flow.config.keys.mac('code', [id, 'email_change', code]).toString('hex');
    await h.sql(`update app.email_challenges set code_hmac = '\\x${hmac}' where id = '${id}';`);
    const result = await change.completeEmailChange(p.b.context(), p.session, {
      challenge: formatChallengeId(id),
      code,
    });
    expect(!result.ok && result.error.code).toBe('AUTH_CODE_INVALID');
    expect(await addressOf(p.user)).toBe(`${p.email}|${p.email}`);
    expect(await addressOf(owner.user)).toBe(`${owner.email}|${owner.email}`);
    await expect(flow.sessions.resolveSession(owner.cookie)).resolves.not.toBeNull();
  });

  it("a challenge one user started cannot complete in another user's session", async () => {
    const a = await signedIn();
    const b = await signedIn();
    const next = address('wanted');
    const mail = await startChange(a, next);
    if (mail === null) throw new Error('no code was mailed');
    // The same browser binding too, so only the user check stands in the way.
    const pre = a.b.cookies.get(h.config.cookies.pre);
    if (pre === undefined) throw new Error('no pre sign in cookie');
    b.b.cookies.set(h.config.cookies.pre, pre);
    const stolen = await change.completeEmailChange(b.b.context(), b.session, mail);
    expect(!stolen.ok && stolen.error.code).toBe('AUTH_CODE_INVALID');
    expect(await addressOf(b.user)).toBe(`${b.email}|${b.email}`);
    expect(await addressOf(a.user)).toBe(`${a.email}|${a.email}`);
    expect(
      await h.sql(`select attempts from app.email_challenges where user_id = '${a.user}';`),
    ).toBe('0');
    const own = await change.completeEmailChange(a.b.context(), a.session, mail);
    expect(own.ok).toBe(true);
  });

  it('a wrong code is refused and counted', async () => {
    const p = await signedIn();
    const mail = await startChange(p, address('typo'));
    if (mail === null) throw new Error('no code was mailed');
    const wrong = await change.completeEmailChange(p.b.context(), p.session, {
      ...mail,
      code: wrongCode(mail.code),
    });
    expect(!wrong.ok && wrong.error.code).toBe('AUTH_CODE_INVALID');
    expect(await addressOf(p.user)).toBe(`${p.email}|${p.email}`);
  });

  it('a sign up of the same address racing the change gives the generic failure and changes nothing', async () => {
    const p = await signedIn();
    const contested = address('contested');
    const mail = await startChange(p, contested);
    if (mail === null) throw new Error('no code was mailed');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready: () => void = () => undefined;
    const inserted = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const rival = newId('usr');
    const signUp = withAuth(h.authDb, async (tx) => {
      await tx
        .insertInto('users')
        .values({
          id: rival,
          email: contested,
          email_normalized: contested,
          email_verified_at: new Date(),
        })
        .execute();
      ready();
      await gate;
    });
    await inserted;
    const completing = change.completeEmailChange(p.b.context(), p.session, mail);
    try {
      await waitForLockWait();
    } finally {
      release();
    }
    await signUp;
    const result = await completing;
    expect(!result.ok && result.error.code).toBe('AUTH_CODE_INVALID');
    expect(await addressOf(p.user)).toBe(`${p.email}|${p.email}`);
    expect(await addressOf(rival)).toBe(`${contested}|${contested}`);
    await expect(flow.sessions.resolveSession(p.cookie)).resolves.not.toBeNull();
  });

  it('afterwards other sessions are gone, the old address has a notice, and its pending challenges are void', async () => {
    const p = await signedIn();
    const laptop = newBrowser();
    const second = await flow.sessions.startSession(laptop.context(), {
      userId: p.user,
      method: 'email',
    });
    laptop.apply(second.setCookies);
    const issuer = createCodeIssuer(flow.config, {
      store: {
        user: (userId, work) => withUser(h.db, { userId }, work),
        auth: (work) => withAuth(h.authDb, work),
      },
      logger: logger(),
      mailer: flow.mail.mailer,
    });
    const link = await issuer.issue(newBrowser().context(), {
      purpose: 'link_identity',
      email: p.email,
      userId: p.user,
      linking: { provider: 'github', account: 'octo', subject: '42' },
    });
    expect(link.ok).toBe(true);
    const oldInbox = newBrowser();
    const signIn = await requestCode(flow, oldInbox, p.email);
    expect(signIn).not.toBeNull();
    const elsewhere = await change.startEmailChange(laptop.context(), second.session, {
      newEmail: address('elsewhere'),
    });
    expect(elsewhere.ok).toBe(true);

    const next = address('final');
    const mail = await startChange(p, next);
    if (mail === null) throw new Error('no code was mailed');
    const noticesBefore = flow.mail.notices.length;
    const done = await change.completeEmailChange(p.b.context(), p.session, mail);
    if (!done.ok) throw done.error;
    await done.value.send();

    await expect(flow.sessions.resolveSession(cookieOf(laptop))).resolves.toBeNull();
    await expect(flow.sessions.resolveSession(p.cookie)).resolves.toMatchObject({ email: next });
    expect(flow.mail.notices.slice(noticesBefore)).toEqual([
      { to: p.email, notice: { kind: 'email_changed', newAddress: next, at: anyDate } },
    ]);
    expect(
      await h.sql(
        `select count(*) from app.email_challenges where consumed_at is null and (email_normalized = '${p.email}' or user_id = '${p.user}');`,
      ),
    ).toBe('0');
    // The sign in code mailed to the old address before the change no longer opens the account.
    if (signIn === null) throw new Error('no sign in code');
    const late = await flow.signIn.verifyEmailCode(oldInbox.context(), signIn);
    expect(late.ok).toBe(false);
  });

  it('drefyn_app updating users.email fails with permission denied', async () => {
    const p = await signedIn();
    await expect(
      withUser(h.db, { userId: p.user }, (tx) =>
        sql`update app.users set email = 'stolen@example.com' where id = ${p.user}`.execute(tx),
      ),
    ).rejects.toThrow(/permission denied/);
    expect(await addressOf(p.user)).toBe(`${p.email}|${p.email}`);
  });
});
