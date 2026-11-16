import { randomBytes } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import { googleAccount } from '../oauth-fakes.ts';
import { Jar } from '../oauth-fixtures.ts';
import { input, newOrg, testIp } from './support/api-keys.ts';
import { newBrowser } from './support/email.ts';
import {
  agePassword,
  ageSession,
  emailStepUp,
  enrollNow,
  enrolledPerson,
  enrolmentWorld,
  errorOf,
  oauthTrip,
  passwordStepUp,
  setPassword,
  signedIn,
  type EnrolmentWorld,
} from './support/enrolment.ts';
import {
  challengesOf,
  count,
  currentCode,
  factorPost,
  sessionsOf,
  unusedCodesOf,
  wrongTotp,
} from './support/factor.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';

const fresh = harness();
let h: Harness;
let n = 0;
const address = (label: string) =>
  `${label}${String((n += 1))}-${randomBytes(3).toString('hex')}@enrol.example.com`;

const factorRow = (userId: string) =>
  h.sql(
    `select coalesce((select (confirmed_at is not null)::text || '|' || coalesce(last_used_step::text, '-') || '|' || failed_attempts from app.totp_credentials where user_id = '${userId}'), 'none');`,
  );
const devicesOf = (userId: string) => count(h, `app.known_devices where user_id = '${userId}'`);

// A challenge as a sign in in another browser would leave it.
const plantChallenge = (userId: string) =>
  h.sql(
    `insert into app.factor_challenges (user_id, secret_hash, method, return_to, expires_at) values ('${userId}', sha256('x'::bytea), 'email', '/', now() + interval '10 minutes');`,
  );

async function fresher(w: EnrolmentWorld, label: string) {
  const userId = await h.user(address(label));
  return { userId, ...(await signedIn(w, userId)) };
}

describeWithStack('second factor enrolment against Postgres', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  it('refuses recent auth with no step up, at start and at confirm', async () => {
    const w = enrolmentWorld(h);
    const { browser, session } = await fresher(w, 'plain');
    const start = await w.factors.startEnrollment(browser.context(), session);
    expect(errorOf(start)).toBe('AUTH_RECENT_AUTH_REQUIRED');
    const confirm = await w.factors.confirmEnrollment(browser.context(), session, {
      code: await currentCode(h),
    });
    expect(errorOf(confirm)).toBe('AUTH_RECENT_AUTH_REQUIRED');
    expect(await factorRow(session.userId)).toBe('none');
  });

  it('refuses a step up older than 5 minutes, at start and at confirm', async () => {
    const w = enrolmentWorld(h);
    const { browser, session } = await fresher(w, 'old');
    const stepped = await emailStepUp(w, browser, session);
    await ageSession(h, stepped, 6);
    expect(errorOf(await w.factors.startEnrollment(browser.context(), stepped))).toBe(
      'AUTH_RECENT_AUTH_REQUIRED',
    );
    // A pending row made while fresh cannot be confirmed once the step up is old.
    await ageSession(h, stepped, 0);
    expect(errorOf(await w.factors.startEnrollment(browser.context(), stepped))).toBe('ok');
    await ageSession(h, stepped, 6);
    const confirm = await w.factors.confirmEnrollment(browser.context(), stepped, {
      code: await currentCode(h),
    });
    expect(errorOf(confirm)).toBe('AUTH_RECENT_AUTH_REQUIRED');
    expect(await factorRow(session.userId)).toBe('false|-|0');
  });

  it('refuses a proof the session made for itself: set a password, step up with it', async () => {
    const w = enrolmentWorld(h);
    const { browser, session } = await fresher(w, 'thief-set');
    await setPassword(w, session);
    const stepped = await passwordStepUp(w, browser, session);
    expect(stepped.stepUpMethod).toBe('password');
    expect(errorOf(await w.factors.startEnrollment(browser.context(), stepped))).toBe(
      'AUTH_RECENT_AUTH_REQUIRED',
    );
    expect(await factorRow(session.userId)).toBe('none');
  });

  it('refuses a proof the session made for itself at confirm too: change a password, step up', async () => {
    const w = enrolmentWorld(h);
    const { userId, browser, session } = await fresher(w, 'thief-change');
    await setPassword(w, session);
    await agePassword(h, userId, 48);
    // Started with a good proof, then the session changes the password with recent auth
    // alone and steps up with the new one.
    const settled = await passwordStepUp(w, browser, session);
    expect(errorOf(await w.factors.startEnrollment(browser.context(), settled))).toBe('ok');
    const changed = await w.password.changePassword(browser.context(), settled, {
      newPassword: 'a password the thief chose today',
    });
    expect(errorOf(changed)).toBe('ok');
    const own = await w.sessions.stepUpWithPassword(browser.context(), settled, {
      password: 'a password the thief chose today',
    });
    if (!own.ok) throw own.error;
    const confirm = await w.factors.confirmEnrollment(browser.context(), own.value, {
      code: await currentCode(h),
    });
    expect(errorOf(confirm)).toBe('AUTH_RECENT_AUTH_REQUIRED');
    expect(await factorRow(userId)).toBe('false|-|0');
  });

  it('passes the same steps once the password hash is 24 hours old', async () => {
    const w = enrolmentWorld(h);
    const { userId, browser, session } = await fresher(w, 'settled');
    await setPassword(w, session);
    await agePassword(h, userId, 23);
    const early = await passwordStepUp(w, browser, session);
    expect(errorOf(await w.factors.startEnrollment(browser.context(), early))).toBe(
      'AUTH_RECENT_AUTH_REQUIRED',
    );
    await agePassword(h, userId, 24);
    const stepped = await passwordStepUp(w, browser, session);
    const { codes } = await enrollNow(h, w, browser, stepped);
    expect(codes).toHaveLength(10);
    expect((await factorRow(userId)).startsWith('true|')).toBe(true);
  });

  it('takes an email code step up whatever the password age', async () => {
    const w = enrolmentWorld(h);
    const { userId, browser, session } = await fresher(w, 'email-step');
    await setPassword(w, session);
    const stepped = await emailStepUp(w, browser, session);
    await enrollNow(h, w, browser, stepped);
    expect((await factorRow(userId)).startsWith('true|')).toBe(true);
  });

  it('takes a provider step up whatever the password age', async () => {
    const w = enrolmentWorld(h);
    const email = address('google');
    const account = googleAccount(email, { sub: `g-${email}` });
    const signUp = await oauthTrip(w, account);
    if (signUp.done?.ok !== true || signUp.done.value.kind !== 'signed_in') {
      throw new Error('no Google sign in');
    }
    const session = signUp.done.value.session;
    await setPassword(w, session);
    const step = await oauthTrip(w, account, { jar: signUp.jar, purpose: 'step_up', session });
    if (step.done?.ok !== true || step.done.value.kind !== 'stepped_up') {
      throw new Error('no Google step up');
    }
    const browser = newBrowser();
    await enrollNow(h, w, browser, step.done.value.session);
    expect((await factorRow(session.userId)).startsWith('true|')).toBe(true);
  });

  it('with email off and no provider, a new password enrolls after 24 hours, or sooner by linking a provider', async () => {
    const w = enrolmentWorld(h, { env: { DREFYN_AUTH_EMAIL: 'off' } });
    const { userId, browser, session } = await fresher(w, 'cli');
    await setPassword(w, session);
    const now = await passwordStepUp(w, browser, session);
    expect(errorOf(await w.factors.startEnrollment(browser.context(), now))).toBe(
      'AUTH_RECENT_AUTH_REQUIRED',
    );
    await agePassword(h, userId, 25);
    const later = await passwordStepUp(w, browser, session);
    expect(errorOf(await w.factors.startEnrollment(browser.context(), later))).toBe('ok');

    // Another such person links Google the same day and steps up with it.
    const other = await fresher(w, 'cli-link');
    await setPassword(w, other.session);
    const email = address('cli-google');
    const account = googleAccount(email, { sub: `g-${email}` });
    const jar = new Jar();
    for (const [name, value] of other.browser.cookies) jar.cookies.set(name, value);
    const link = await oauthTrip(w, account, { jar, purpose: 'link', session: other.session });
    expect(errorOf(link.done)).toBe('ok');
    const step = await oauthTrip(w, account, {
      jar: link.jar,
      purpose: 'step_up',
      session: other.session,
    });
    if (step.done?.ok !== true || step.done.value.kind !== 'stepped_up') {
      throw new Error('no Google step up');
    }
    await enrollNow(h, w, other.browser, step.done.value.session);
    expect((await factorRow(other.userId)).startsWith('true|')).toBe(true);
  });

  it('refuses a pending row 15 minutes after it was sealed', async () => {
    const w = enrolmentWorld(h);
    const { userId, browser, session } = await fresher(w, 'pending');
    const stepped = await emailStepUp(w, browser, session);
    expect(errorOf(await w.factors.startEnrollment(browser.context(), stepped))).toBe('ok');
    await h.sql(
      `update app.totp_credentials set updated_at = now() - interval '15 minutes 1 second' where user_id = '${userId}';`,
    );
    const confirm = await w.factors.confirmEnrollment(browser.context(), stepped, {
      code: await currentCode(h),
    });
    expect(errorOf(confirm)).toBe('AUTH_FACTOR_CHALLENGE_EXPIRED');
    // Starting again seals afresh and the 15 minutes start over.
    await enrollNow(h, w, browser, stepped);
    expect((await factorRow(userId)).startsWith('true|')).toBe(true);
  });

  it('never overwrites a confirmed row: start answers AUTH_FACTOR_ALREADY_ENROLLED', async () => {
    const w = enrolmentWorld(h);
    const person = await enrolledPerson(h, w);
    const sealed = () =>
      h.sql(
        `select encode(secret_sealed, 'hex') from app.totp_credentials where user_id = '${person.userId}';`,
      );
    const before = await sealed();
    const again = await w.factors.startEnrollment(person.browser.context(), person.session);
    expect(errorOf(again)).toBe('AUTH_FACTOR_ALREADY_ENROLLED');
    expect(await sealed()).toBe(before);
    expect(await factorRow(person.userId)).toMatch(/^true\|/);
  });

  it('confirm writes last_used_step and failed_attempts = 0, so the confirming code fails at sign in', async () => {
    const w = enrolmentWorld(h);
    const { userId, browser, session } = await fresher(w, 'replay');
    const stepped = await emailStepUp(w, browser, session);
    expect(errorOf(await w.factors.startEnrollment(browser.context(), stepped))).toBe('ok');
    const code = await currentCode(h);
    const typo = await w.factors.confirmEnrollment(browser.context(), stepped, {
      code: wrongTotp(code),
    });
    expect(typo.ok && typo.value.kind).toBe('mistyped');
    expect(await factorRow(userId)).toBe('false|-|1');
    const confirmed = await w.factors.confirmEnrollment(browser.context(), stepped, { code });
    expect(confirmed.ok && confirmed.value.kind).toBe('enrolled');
    const step = await h.sql(
      `select floor(extract(epoch from now()) / 30)::int from app.totp_credentials limit 1;`,
    );
    expect(await factorRow(userId)).toMatch(
      new RegExp(`^true\\|(${step}|${String(Number(step) - 1)})\\|0$`),
    );
    // The same code at the next sign in is a replay.
    const other = newBrowser();
    const started = await w.sessions.startSession(other.context(), { userId, method: 'email' });
    expect(started).toMatchObject({ kind: 'factor_required' });
    other.apply(started.setCookies);
    const post = factorPost(w.config, other, 'totp', code);
    const replay = await w.challenges.completeChallenge(other.context(), post);
    expect(errorOf(replay)).toBe('AUTH_FACTOR_INVALID');
  });

  it('a repeat confirm never shows recovery codes twice', async () => {
    const w = enrolmentWorld(h);
    const person = await enrolledPerson(h, w);
    const again = await w.factors.confirmEnrollment(person.browser.context(), person.session, {
      code: await currentCode(h),
    });
    expect(errorOf(again)).toBe('AUTH_FACTOR_ALREADY_ENROLLED');
    expect(JSON.stringify(again)).not.toMatch(/[0-9a-z]{6}-[0-9a-z]{6}/);
    expect(await unusedCodesOf(h, person.userId)).toBe(10);
  });

  it('enrolment and removal end the other sessions and reset known devices, and API keys keep working', async () => {
    const w = enrolmentWorld(h);
    const org = await newOrg(h);
    const made = await h.apiKeys().createApiKey(org.owner, input());
    if (!made.ok) throw made.error;
    const userId = org.owner.userId;
    // Two more browsers, each signed in and known.
    for (const name of ['a', 'b']) {
      await signedIn(w, userId);
      await h.sql(
        `insert into app.known_devices (user_id, device_hash, user_agent_family) values ('${userId}', sha256('${name}'::bytea), 'Firefox on Linux');`,
      );
    }
    const { browser, session } = await signedIn(w, userId);
    expect(await sessionsOf(h, userId)).toBeGreaterThanOrEqual(4);
    expect(await devicesOf(userId)).toBe(2);
    const stepped = await emailStepUp(w, browser, session);
    const { send, codes } = await enrollNow(h, w, browser, stepped);
    expect(await sessionsOf(h, userId)).toBe(1);
    expect(await devicesOf(userId)).toBe(1);
    const verified = await h.verifier().verifyApiKey(`Bearer ${made.value.secret}`, testIp());
    expect(verified.ok).toBe(true);
    await send();
    expect(w.mail.notices.map((m) => m.notice.kind)).toEqual(['second_factor_added']);

    const removed = await w.factors.removeFactor(browser.context(), stepped, {
      kind: 'recovery_code',
      code: codes[0] ?? '',
    });
    if (!removed.ok) throw removed.error;
    expect(await factorRow(userId)).toBe('none');
    expect(await unusedCodesOf(h, userId)).toBe(0);
    expect(await sessionsOf(h, userId)).toBe(1);
    expect(await devicesOf(userId)).toBe(1);
    const still = await h.verifier().verifyApiKey(`Bearer ${made.value.secret}`, testIp());
    expect(still.ok).toBe(true);
  });

  it('enrolment, removal and replacing codes each delete the person challenge', async () => {
    const w = enrolmentWorld(h);
    const { userId, browser, session } = await fresher(w, 'lifecycle');
    const stepped = await emailStepUp(w, browser, session);
    await plantChallenge(userId);
    const { codes } = await enrollNow(h, w, browser, stepped);
    expect(await challengesOf(h, userId)).toBe(0);

    await plantChallenge(userId);
    const replaced = await w.factors.replaceRecoveryCodes(browser.context(), stepped, {
      kind: 'recovery_code',
      code: codes[0] ?? '',
    });
    if (!replaced.ok) throw replaced.error;
    expect(await challengesOf(h, userId)).toBe(0);

    await plantChallenge(userId);
    const removed = await w.factors.removeFactor(browser.context(), stepped, {
      kind: 'recovery_code',
      code: replaced.value.recoveryCodes[0] ?? '',
    });
    if (!removed.ok) throw removed.error;
    expect(await challengesOf(h, userId)).toBe(0);
  });

  it('removing or replacing needs a code in that request, and old codes stop working in the same transaction', async () => {
    const w = enrolmentWorld(h);
    const person = await enrolledPerson(h, w);
    const b = person.browser.context();
    expect(
      errorOf(await w.factors.removeFactor(b, person.session, { kind: 'totp', code: '' })),
    ).toBe('AUTH_FACTOR_INVALID');
    expect(
      errorOf(
        await w.factors.replaceRecoveryCodes(b, person.session, {
          kind: 'recovery_code',
          code: 'aaaaaa-aaaaaa-aaaaaa-aaaaaa',
        }),
      ),
    ).toBe('AUTH_FACTOR_INVALID');
    expect(await unusedCodesOf(h, person.userId)).toBe(10);

    const replaced = await w.factors.replaceRecoveryCodes(b, person.session, {
      kind: 'recovery_code',
      code: person.codes[0] ?? '',
    });
    if (!replaced.ok) throw replaced.error;
    expect(await unusedCodesOf(h, person.userId)).toBe(10);
    await replaced.value.send();
    expect(w.mail.notices.map((m) => m.notice.kind)).toContain('recovery_codes_replaced');
    // An old code, never used, no longer works anywhere.
    const old = await w.factors.stepUpWithFactor(b, person.session, {
      kind: 'recovery_code',
      code: person.codes[1] ?? '',
    });
    expect(errorOf(old)).toBe('AUTH_FACTOR_INVALID');
    const fresh = await w.factors.stepUpWithFactor(b, person.session, {
      kind: 'recovery_code',
      code: replaced.value.recoveryCodes[1] ?? '',
    });
    expect(errorOf(fresh)).toBe('ok');
    expect(await unusedCodesOf(h, person.userId)).toBe(9);
  });

  it('a mail outage never blocks enrolment, removal or replacing codes', async () => {
    const w = enrolmentWorld(h);
    const person = await enrolledPerson(h, w);
    w.mail.failNext();
    await expect(person.send()).resolves.toBeUndefined();
    expect(await factorRow(person.userId)).toMatch(/^true\|/);
    const replaced = await w.factors.replaceRecoveryCodes(
      person.browser.context(),
      person.session,
      { kind: 'recovery_code', code: person.codes[0] ?? '' },
    );
    if (!replaced.ok) throw replaced.error;
    w.mail.failNext();
    await expect(replaced.value.send()).resolves.toBeUndefined();
    const removed = await w.factors.removeFactor(person.browser.context(), person.session, {
      kind: 'recovery_code',
      code: replaced.value.recoveryCodes[0] ?? '',
    });
    if (!removed.ok) throw removed.error;
    w.mail.failNext();
    await expect(removed.value.send()).resolves.toBeUndefined();
    expect(await factorRow(person.userId)).toBe('none');
    expect(h.logs.filter((l) => l.event === 'auth.factor_notice_failed')).toHaveLength(3);
  });

  it('with the flag off enrolment is hidden, and an enrolled person stays protected', async () => {
    const w = enrolmentWorld(h);
    const person = await enrolledPerson(h, w);
    w.setFlag(false);
    const status = await w.factors.status(person.session);
    expect(status.ok && status.value).toEqual({
      available: false,
      enrolled: true,
      recoveryCodesLeft: 10,
    });
    const other = await fresher(w, 'flag-off');
    const stepped = await emailStepUp(w, other.browser, other.session);
    expect(errorOf(await w.factors.startEnrollment(other.browser.context(), stepped))).toBe(
      'AUTH_NOT_FOUND',
    );
    expect(
      errorOf(
        await w.factors.confirmEnrollment(other.browser.context(), stepped, {
          code: await currentCode(h),
        }),
      ),
    ).toBe('AUTH_NOT_FOUND');
    expect(await factorRow(other.userId)).toBe('none');
    // Signing in still needs the factor.
    const started = await w.sessions.startSession(newBrowser().context(), {
      userId: person.userId,
      method: 'email',
    });
    expect(started).toMatchObject({ kind: 'factor_required' });
    // And the person can still take it off.
    const removed = await w.factors.removeFactor(person.browser.context(), person.session, {
      kind: 'recovery_code',
      code: person.codes[0] ?? '',
    });
    expect(errorOf(removed)).toBe('ok');
  });

  it('with the flag on, status offers enrolment to a person without a factor', async () => {
    const w = enrolmentWorld(h);
    const { session } = await fresher(w, 'status');
    const status = await w.factors.status(session);
    expect(status.ok && status.value).toEqual({
      available: true,
      enrolled: false,
      recoveryCodesLeft: 0,
    });
  });
});
