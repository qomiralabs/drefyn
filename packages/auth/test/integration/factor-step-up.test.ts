import { randomBytes } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import { googleAccount } from '../oauth-fakes.ts';
import { newBrowser } from './support/email.ts';
import {
  PASSWORD,
  agePassword,
  emailStepUp,
  enrollNow,
  enrolledPerson,
  enrolmentWorld,
  errorOf,
  oauthTrip,
  setPassword,
  signedIn,
  stepUpByEmail,
} from './support/enrolment.ts';
import { currentCode, factorPost, wrongTotp } from './support/factor.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';

const fresh = harness();
let h: Harness;
let n = 0;
const address = (label: string) =>
  `${label}${String((n += 1))}-${randomBytes(3).toString('hex')}@stepup.example.com`;

// The post is built first: it gives the browser its pre sign in cookie, which the context
// must then carry.
async function complete(
  w: ReturnType<typeof enrolmentWorld>,
  b: ReturnType<typeof newBrowser>,
  post: ReturnType<typeof factorPost>,
) {
  return w.challenges.completeChallenge(b.context(), post);
}

const stepUpOf = (sessionId: string) =>
  h.sql(`select coalesce(step_up_method, '-') from app.sessions where id = '${sessionId}';`);

describeWithStack('step up once a second factor is enrolled', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  it('refuses a password step up with AUTH_FACTOR_REQUIRED', async () => {
    const w = enrolmentWorld(h);
    const person = await enrolledPerson(h, w);
    await setPassword(w, person.session);
    const result = await w.sessions.stepUpWithPassword(person.browser.context(), person.session, {
      password: PASSWORD,
    });
    expect(errorOf(result)).toBe('AUTH_FACTOR_REQUIRED');
    expect(await stepUpOf(person.session.sessionId)).toBe('email');
  });

  it('refuses an email code step up at start, with no code sent', async () => {
    const w = enrolmentWorld(h);
    const person = await enrolledPerson(h, w);
    const before = w.mail.sent.length;
    const started = await w.sessions.startStepUpCode(person.browser.context(), person.session);
    expect(errorOf(started)).toBe('AUTH_FACTOR_REQUIRED');
    expect(w.mail.sent.length).toBe(before);
  });

  it('refuses an email code asked for before enrolment and verified after it', async () => {
    const w = enrolmentWorld(h);
    const userId = await h.user(address('late-email'));
    const { browser, session } = await signedIn(w, userId);
    const stepped = await emailStepUp(w, browser, session);
    const pending = await stepUpByEmail(w, browser, stepped);
    await enrollNow(h, w, browser, stepped);
    const verified = await w.sessions.verifyStepUpCode(browser.context(), stepped, pending);
    expect(errorOf(verified)).toBe('AUTH_FACTOR_REQUIRED');
    expect(await stepUpOf(stepped.sessionId)).toBe('email');
  });

  it('refuses a provider step up at start', async () => {
    const w = enrolmentWorld(h);
    const email = address('oauth-start');
    const account = googleAccount(email, { sub: `g-${email}` });
    const signUp = await oauthTrip(w, account);
    if (signUp.done?.ok !== true || signUp.done.value.kind !== 'signed_in') {
      throw new Error('no Google sign in');
    }
    const session = signUp.done.value.session;
    const stepped = await emailStepUp(w, newBrowser(), session);
    await enrollNow(h, w, newBrowser(), stepped);
    const trip = await oauthTrip(w, account, { jar: signUp.jar, purpose: 'step_up', session });
    expect(errorOf(trip.started)).toBe('AUTH_FACTOR_REQUIRED');
  });

  it('refuses a provider step up begun before enrolment and finished after it', async () => {
    const w = enrolmentWorld(h);
    const email = address('oauth-late');
    const account = googleAccount(email, { sub: `g-${email}` });
    const signUp = await oauthTrip(w, account);
    if (signUp.done?.ok !== true || signUp.done.value.kind !== 'signed_in') {
      throw new Error('no Google sign in');
    }
    const session = signUp.done.value.session;
    const trip = await oauthTrip(w, account, {
      jar: signUp.jar,
      purpose: 'step_up',
      session,
      beforeCallback: async () => {
        const stepped = await emailStepUp(w, newBrowser(), session);
        await enrollNow(h, w, newBrowser(), stepped);
      },
    });
    expect(errorOf(trip.done)).toBe('AUTH_FACTOR_REQUIRED');
    expect(await stepUpOf(session.sessionId)).toBe('email');
  });

  it('refuses changePassword with the current password, and recent auth still works', async () => {
    const w = enrolmentWorld(h);
    const userId = await h.user(address('change'));
    const { browser, session } = await signedIn(w, userId);
    await setPassword(w, session);
    await agePassword(h, userId, 48);
    const stepped = await emailStepUp(w, browser, session);
    await enrollNow(h, w, browser, stepped);
    const phc = () =>
      h.sql(`select phc from app.password_credentials where user_id = '${userId}';`);
    const before = await phc();
    const withCurrent = await w.password.changePassword(browser.context(), stepped, {
      currentPassword: PASSWORD,
      newPassword: 'another long and quiet sentence',
    });
    expect(errorOf(withCurrent)).toBe('AUTH_FACTOR_REQUIRED');
    expect(await phc()).toBe(before);
    const recent = await w.password.changePassword(browser.context(), stepped, {
      newPassword: 'another long and quiet sentence',
    });
    expect(errorOf(recent)).toBe('ok');
  });

  it('steps up with the factor and records which kind', async () => {
    const w = enrolmentWorld(h);
    const person = await enrolledPerson(h, w);
    const byCode = await w.factors.stepUpWithFactor(person.browser.context(), person.session, {
      kind: 'recovery_code',
      code: person.codes[0] ?? '',
    });
    expect(byCode.ok && byCode.value.stepUpMethod).toBe('recovery_code');
    expect(await stepUpOf(person.session.sessionId)).toBe('recovery_code');
    await w.drain();
    expect(w.mail.notices.at(-1)?.notice).toMatchObject({
      kind: 'recovery_code_used',
      codesLeft: 9,
    });
  });
});

describeWithStack('second factor notices', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  it('wrong codes on a pending row send no failure mail', async () => {
    const w = enrolmentWorld(h);
    const userId = await h.user(address('pending-typos'));
    const { browser, session } = await signedIn(w, userId);
    const stepped = await emailStepUp(w, browser, session);
    expect(errorOf(await w.factors.startEnrollment(browser.context(), stepped))).toBe('ok');
    const code = await currentCode(h);
    for (let i = 0; i < 4; i += 1) {
      const typo = await w.factors.confirmEnrollment(browser.context(), stepped, {
        code: wrongTotp(code),
      });
      expect(typo.ok && typo.value.kind).toBe('mistyped');
    }
    await w.drain();
    expect(w.mail.notices).toEqual([]);
  });

  it('fires when failed_attempts reaches 3 and on a failed recovery code, at most once in 6 hours', async () => {
    const w = enrolmentWorld(h);
    const person = await enrolledPerson(h, w);
    const other = newBrowser();
    const started = await w.sessions.startSession(other.context(), {
      userId: person.userId,
      method: 'email',
    });
    other.apply(started.setCookies);
    const wrong = wrongTotp(await currentCode(h));
    const failures = () => w.mail.notices.filter((m) => m.notice.kind === 'second_factor_failures');
    for (let i = 0; i < 2; i += 1) {
      await complete(w, other, factorPost(w.config, other, 'totp', wrong));
    }
    await w.drain();
    expect(failures()).toEqual([]);
    await complete(w, other, factorPost(w.config, other, 'totp', wrong));
    await w.drain();
    expect(failures()).toHaveLength(1);
    // A failed recovery code in the same 6 hours is capped.
    const again = newBrowser();
    const second = await w.sessions.startSession(again.context(), {
      userId: person.userId,
      method: 'email',
    });
    again.apply(second.setCookies);
    await complete(
      w,
      again,
      factorPost(w.config, again, 'recovery_code', 'aaaaaa-aaaaaa-aaaaaa-aaaaaa'),
    );
    await w.drain();
    expect(failures()).toHaveLength(1);

    // On its own, a failed recovery code warns.
    const fresh = enrolmentWorld(h);
    const lone = await enrolledPerson(h, fresh, 'lone');
    const lb = newBrowser();
    const ls = await fresh.sessions.startSession(lb.context(), {
      userId: lone.userId,
      method: 'email',
    });
    lb.apply(ls.setCookies);
    await complete(
      fresh,
      lb,
      factorPost(fresh.config, lb, 'recovery_code', 'aaaaaa-aaaaaa-aaaaaa-aaaaaa'),
    );
    await fresh.drain();
    expect(fresh.mail.notices.map((m) => m.notice.kind)).toContain('second_factor_failures');
  });
});
