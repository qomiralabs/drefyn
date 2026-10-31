import fc from 'fast-check';
import { beforeAll, expect, it, vi } from 'vitest';
import { formatChallengeId, type AuthConfig, type CookieSpec } from '../../src/index.ts';
import {
  configWith,
  flowFor,
  newBrowser,
  requestCode,
  wrongCode,
  type Browser,
  type Flow,
} from './support/email.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';

const fresh = harness();
let h: Harness;

const attemptsOf = (challengeId: string) =>
  h.sql(`select attempts from app.email_challenges where id = '${challengeId}';`);
const usersNamed = (email: string) =>
  h.sql(`select count(*) from app.users where email_normalized = '${email}';`);
const sessionsOf = (email: string) =>
  h.sql(
    `select count(*) from app.sessions s join app.users u on u.id = s.user_id where u.email_normalized = '${email}';`,
  );

let n = 0;
const address = (label: string) => `${label}${String((n += 1))}@example.com`;

const sessionCookie = (config: AuthConfig, cookies: readonly CookieSpec[]) =>
  cookies.find((c) => c.name === config.cookies.session)?.value;

async function signedUpFlow(): Promise<Flow> {
  return flowFor(h, configWith({ DREFYN_AUTH_SIGNUP: 'open' }));
}

describeWithStack('email code sign in against Postgres', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  it('a right code from the asking browser signs in once, with method email', async () => {
    const flow = await signedUpFlow();
    const email = address('known');
    await h.user(email);
    const b = newBrowser();
    const mail = await requestCode(flow, b, email);
    if (mail === null) throw new Error('no mail for a known address');
    const result = await flow.signIn.verifyEmailCode(b.context(), mail);
    if (!result.ok) throw result.error;
    expect(result.value.session.method).toBe('email');
    expect(result.value.returnTo).toBe('/');
    const cookie = sessionCookie(flow.config, result.value.setCookies);
    expect(await flow.sessions.resolveSession(cookie)).toMatchObject({ email });
    // The pre sign in cookie is cleared by the new session.
    expect(
      result.value.setCookies.find((c) => c.name === flow.config.cookies.pre)?.maxAgeSeconds,
    ).toBe(0);
    const again = await flow.signIn.verifyEmailCode(b.context(), mail);
    expect(!again.ok && again.error.code).toBe('AUTH_CODE_INVALID');
    expect(await sessionsOf(email)).toBe('1');
  });

  it('a typed code with no challenge id finds this browser’s newest challenge', async () => {
    const flow = await signedUpFlow();
    const email = address('typed');
    await h.user(email);
    const b = newBrowser();
    const mail = await requestCode(flow, b, email);
    if (mail === null) throw new Error('no mail');
    const spaced = `${mail.code.slice(0, 4)} ${mail.code.slice(4)}`;
    const result = await flow.signIn.verifyEmailCode(b.context(), { code: spaced });
    expect(result.ok).toBe(true);
  });

  it('keeps a safe returnTo and drops one that leaves the origin', async () => {
    const flow = await signedUpFlow();
    const email = address('return');
    await h.user(email);
    for (const [given, kept] of [
      ['/acme/docs?tab=1', '/acme/docs?tab=1'],
      ['//evil.example/x', '/'],
      ['https://evil.example/', '/'],
    ] as const) {
      const b = newBrowser();
      const start = await flow.signIn.startEmailSignIn(b.context(), { email, returnTo: given });
      if (!start.ok) throw start.error;
      b.apply(start.value.setCookies);
      await start.value.send();
      const sent = flow.mail.sent.at(-1);
      if (sent === undefined) throw new Error('no mail');
      const result = await flow.signIn.verifyEmailCode(b.context(), { code: sent.code });
      if (!result.ok) throw result.error;
      expect(result.value.returnTo).toBe(kept);
    }
  });

  it('without the binding cookie verify answers AUTH_CHALLENGE_BINDING and uses no attempt', async () => {
    const flow = await signedUpFlow();
    const email = address('bind');
    await h.user(email);
    const asking = newBrowser();
    const mail = await requestCode(flow, asking, email);
    if (mail === null) throw new Error('no mail');
    const elsewhere = newBrowser();
    for (const b of [elsewhere, newBrowser()]) {
      const result = await flow.signIn.verifyEmailCode(b.context(), mail);
      expect(!result.ok && result.error.code).toBe('AUTH_CHALLENGE_BINDING');
    }
    // A pre cookie from another browser is not the binding either.
    await requestCode(flow, elsewhere, address('other'));
    const other = await flow.signIn.verifyEmailCode(elsewhere.context(), mail);
    expect(!other.ok && other.error.code).toBe('AUTH_CHALLENGE_BINDING');
    const typed = await flow.signIn.verifyEmailCode(newBrowser().context(), { code: mail.code });
    expect(!typed.ok && typed.error.code).toBe('AUTH_CHALLENGE_BINDING');
    expect(await attemptsOf(mail.challengeId)).toBe('0');
    const result = await flow.signIn.verifyEmailCode(asking.context(), mail);
    expect(result.ok).toBe(true);
  });

  it('a new challenge from browser B leaves browser A’s open challenge valid', async () => {
    const flow = await signedUpFlow();
    const email = address('m1');
    await h.user(email);
    const a = newBrowser();
    const b = newBrowser();
    const fromA = await requestCode(flow, a, email);
    const fromB = await requestCode(flow, b, email);
    if (fromA === null || fromB === null) throw new Error('no mail');
    const result = await flow.signIn.verifyEmailCode(a.context(), fromA);
    expect(result.ok).toBe(true);
    const resultB = await flow.signIn.verifyEmailCode(b.context(), fromB);
    expect(resultB.ok).toBe(true);
  });

  it('a new challenge from the same browser replaces its older one', async () => {
    const flow = await signedUpFlow();
    const email = address('same');
    await h.user(email);
    const b = newBrowser();
    const first = await requestCode(flow, b, email);
    const second = await requestCode(flow, b, email);
    if (first === null || second === null) throw new Error('no mail');
    const old = await flow.signIn.verifyEmailCode(b.context(), first);
    expect(!old.ok && old.error.code).toBe('AUTH_CODE_INVALID');
    const current = await flow.signIn.verifyEmailCode(b.context(), second);
    expect(current.ok).toBe(true);
  });

  it('200 parallel verifies against one challenge never let more than 5 attempts through', async () => {
    const config = configWith({ DREFYN_AUTH_SIGNUP: 'open' });
    const compare = vi.spyOn(config.keys, 'verify');
    const flow = flowFor(h, config);
    const email = address('m2');
    await h.user(email);
    const b = newBrowser();
    const mail = await requestCode(flow, b, email);
    if (mail === null) throw new Error('no mail');
    compare.mockClear();
    // One right code among 199 wrong ones: at most one may win, and only if it came in time.
    const guesses = Array.from({ length: 200 }, (_, i) =>
      i === 100 ? mail.code : wrongCode(mail.code),
    );
    const results = await Promise.all(
      guesses.map((code) => flow.signIn.verifyEmailCode(b.context(), { ...mail, code })),
    );
    const codeCompares = compare.mock.calls.filter(([purpose]) => purpose === 'code');
    expect(codeCompares.length).toBeLessThanOrEqual(5);
    expect(Number(await attemptsOf(mail.challengeId))).toBeLessThanOrEqual(5);
    expect(results.filter((r) => r.ok).length).toBeLessThanOrEqual(1);
    expect(Number(await sessionsOf(email))).toBeLessThanOrEqual(1);
  });

  it('after 5 wrong codes even the right one is refused', async () => {
    const flow = await signedUpFlow();
    const email = address('five');
    await h.user(email);
    const b = newBrowser();
    const mail = await requestCode(flow, b, email);
    if (mail === null) throw new Error('no mail');
    for (let i = 0; i < 5; i += 1) {
      await flow.signIn.verifyEmailCode(b.context(), { ...mail, code: wrongCode(mail.code) });
    }
    const result = await flow.signIn.verifyEmailCode(b.context(), mail);
    expect(!result.ok && result.error.code).toBe('AUTH_CHALLENGE_EXPIRED');
    expect(await attemptsOf(mail.challengeId)).toBe('5');
  });

  it('a code past its 10 minutes is refused by database time', async () => {
    const flow = await signedUpFlow();
    const email = address('late');
    await h.user(email);
    const b = newBrowser();
    const mail = await requestCode(flow, b, email);
    if (mail === null) throw new Error('no mail');
    expect(
      await h.sql(
        `select expires_at between now() + interval '9 minutes' and now() + interval '10 minutes' from app.email_challenges where id = '${mail.challengeId}';`,
      ),
    ).toBe('t');
    await h.sql(
      `update app.email_challenges set expires_at = now() - interval '1 second' where id = '${mail.challengeId}';`,
    );
    const result = await flow.signIn.verifyEmailCode(b.context(), mail);
    expect(!result.ok && result.error.code).toBe('AUTH_CHALLENGE_EXPIRED');
  });

  it('code_verify stops a browser after 10 failed codes in the hour, across challenges', async () => {
    const flow = flowFor(
      h,
      configWith({ DREFYN_AUTH_SIGNUP: 'open', DREFYN_AUTH_RATE_CODE_VERIFY: '10/1h' }),
    );
    const email = address('cv');
    await h.user(email);
    const b = newBrowser();
    const outcomes: string[] = [];
    for (let round = 0; round < 3; round += 1) {
      const mail = await requestCode(flow, b, email);
      if (mail === null) throw new Error('no mail');
      for (let i = 0; i < 5; i += 1) {
        const r = await flow.signIn.verifyEmailCode(b.context(), {
          ...mail,
          code: wrongCode(mail.code),
        });
        outcomes.push(r.ok ? 'ok' : r.error.code);
      }
    }
    expect(outcomes.slice(0, 10).every((o) => o === 'AUTH_CODE_INVALID')).toBe(true);
    expect(outcomes.slice(10).every((o) => o === 'AUTH_RATE_LIMITED')).toBe(true);
    // Another browser is keyed apart and is not stopped by these failures.
    const other = newBrowser();
    const mail = await requestCode(flow, other, email);
    if (mail === null) throw new Error('no mail');
    expect((await flow.signIn.verifyEmailCode(other.context(), mail)).ok).toBe(true);
  });

  it('property: no sequence of guesses gets more than 5 compares per challenge or 10 per browser an hour', async () => {
    const config = configWith({
      DREFYN_AUTH_SIGNUP: 'open',
      DREFYN_AUTH_RATE_CODE_VERIFY: '10/1h',
    });
    const compare = vi.spyOn(config.keys, 'verify');
    const flow = flowFor(h, config);
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.oneof(fc.constant('new' as const), fc.nat({ max: 3 })), {
          minLength: 1,
          maxLength: 30,
        }),
        async (steps) => {
          const email = address('prop');
          await h.user(email);
          const b: Browser = newBrowser();
          const open: { challenge: string; challengeId: string; code: string }[] = [];
          compare.mockClear();
          const perChallenge = new Map<string, number>();
          for (const step of steps) {
            if (step === 'new' || open.length === 0) {
              const mail = await requestCode(flow, b, email);
              if (mail === null) throw new Error('no mail');
              open.push(mail);
              continue;
            }
            const target = open[step % open.length];
            if (target === undefined) continue;
            const before = compare.mock.calls.length;
            await flow.signIn.verifyEmailCode(b.context(), {
              challenge: target.challenge,
              code: wrongCode(target.code),
            });
            const reached = compare.mock.calls.length - before;
            perChallenge.set(
              target.challengeId,
              (perChallenge.get(target.challengeId) ?? 0) + reached,
            );
          }
          for (const count of perChallenge.values()) expect(count).toBeLessThanOrEqual(5);
          expect(compare.mock.calls.filter(([p]) => p === 'code').length).toBeLessThanOrEqual(10);
        },
      ),
      { numRuns: 15, seed: 130 },
    );
  });

  describe('signup modes', () => {
    it('open creates a user only after the code proved the address', async () => {
      const flow = flowFor(h, configWith({ DREFYN_AUTH_SIGNUP: 'open' }));
      const email = address('open');
      const b = newBrowser();
      const mail = await requestCode(flow, b, email);
      if (mail === null) throw new Error('open mode sends to a new address');
      expect(await usersNamed(email)).toBe('0');
      await flow.signIn.verifyEmailCode(b.context(), { ...mail, code: wrongCode(mail.code) });
      expect(await usersNamed(email)).toBe('0');
      const result = await flow.signIn.verifyEmailCode(b.context(), mail);
      expect(result.ok).toBe(true);
      expect(await usersNamed(email)).toBe('1');
      expect(
        await h.sql(
          `select email_verified_at is not null from app.users where email_normalized = '${email}';`,
        ),
      ).toBe('t');
    });

    it('invite_only creates a user only with a pending invitation, and mails nobody else', async () => {
      const invited = address('invited');
      const pending = new Set([invited]);
      const flow = flowFor(h, configWith({ DREFYN_AUTH_SIGNUP: 'invite_only' }), {
        invitations: { hasPending: (e: string) => Promise.resolve(pending.has(e)) },
      });
      const stranger = address('stranger');
      expect(await requestCode(flow, newBrowser(), stranger)).toBeNull();
      expect(flow.mail.calls.filter((m) => m.to === stranger)).toHaveLength(0);
      const b = newBrowser();
      const mail = await requestCode(flow, b, invited);
      if (mail === null) throw new Error('an invited address gets mail');
      const result = await flow.signIn.verifyEmailCode(b.context(), mail);
      expect(result.ok).toBe(true);
      expect(await usersNamed(invited)).toBe('1');
      expect(await usersNamed(stranger)).toBe('0');
    });

    it('invite_only answers AUTH_SIGNUP_CLOSED when the invitation went away before the code', async () => {
      const invited = address('revoked');
      const pending = new Set([invited]);
      const flow = flowFor(h, configWith({ DREFYN_AUTH_SIGNUP: 'invite_only' }), {
        invitations: { hasPending: (e: string) => Promise.resolve(pending.has(e)) },
      });
      const b = newBrowser();
      const mail = await requestCode(flow, b, invited);
      if (mail === null) throw new Error('no mail');
      pending.delete(invited);
      const wrong = await flow.signIn.verifyEmailCode(b.context(), {
        ...mail,
        code: wrongCode(mail.code),
      });
      expect(!wrong.ok && wrong.error.code).toBe('AUTH_CODE_INVALID');
      const result = await flow.signIn.verifyEmailCode(b.context(), mail);
      expect(!result.ok && result.error.code).toBe('AUTH_SIGNUP_CLOSED');
      expect(await usersNamed(invited)).toBe('0');
    });

    it('closed signs existing users in, and never mails or creates an unknown address', async () => {
      const flow = flowFor(h, configWith({ DREFYN_AUTH_SIGNUP: 'closed' }));
      const member = address('member');
      await h.user(member);
      const b = newBrowser();
      const mail = await requestCode(flow, b, member);
      if (mail === null) throw new Error('closed mode still mails existing users');
      expect((await flow.signIn.verifyEmailCode(b.context(), mail)).ok).toBe(true);
      const unknown = address('unknown');
      expect(await requestCode(flow, newBrowser(), unknown)).toBeNull();
      expect(flow.mail.calls.filter((m) => m.to === unknown)).toHaveLength(0);
      expect(await usersNamed(unknown)).toBe('0');
    });

    it('closed answers AUTH_SIGNUP_CLOSED only after a right code for an address mailed in open mode', async () => {
      const config = configWith({ DREFYN_AUTH_SIGNUP: 'open' });
      const openFlow = flowFor(h, config);
      const email = address('switched');
      const b = newBrowser();
      const mail = await requestCode(openFlow, b, email);
      if (mail === null) throw new Error('no mail');
      // Same secret, mode turned to closed between the mail and the code.
      const closedConfig = { ...config, signUp: 'closed' as const };
      const closedFlow = flowFor(h, closedConfig);
      const wrong = await closedFlow.signIn.verifyEmailCode(b.context(), {
        ...mail,
        code: wrongCode(mail.code),
      });
      expect(!wrong.ok && wrong.error.code).toBe('AUTH_CODE_INVALID');
      const result = await closedFlow.signIn.verifyEmailCode(b.context(), mail);
      expect(!result.ok && result.error.code).toBe('AUTH_SIGNUP_CLOSED');
      expect(await usersNamed(email)).toBe('0');
    });
  });

  describe('step up codes on the verify path', () => {
    async function stepUpMail(flow: Flow) {
      const email = address('stepup');
      const user = await h.user(email);
      const b = newBrowser();
      const started = await flow.sessions.startSession(b.context(), {
        userId: user,
        method: 'email',
      });
      b.apply(started.setCookies);
      const issued = await flow.sessions.startStepUpCode(b.context(), started.session);
      if (!issued.ok) throw issued.error;
      await issued.value.send();
      const sent = flow.mail.sent.at(-1);
      if (sent === undefined) throw new Error('no step up mail');
      return { email, b, session: started.session, sent, challenge: issued.value.challenge };
    }

    it('verifyEmailCode never creates a session from a step up code, and spends none of its attempts', async () => {
      const flow = await signedUpFlow();
      const { email, b, sent, challenge } = await stepUpMail(flow);
      const before = await sessionsOf(email);
      const result = await flow.signIn.verifyEmailCode(b.context(), { challenge, code: sent.code });
      expect(result.ok).toBe(false);
      expect(await sessionsOf(email)).toBe(before);
      const id = await h.sql(
        `select id from app.email_challenges where purpose = 'step_up' and email_normalized = '${email}';`,
      );
      expect(await attemptsOf(id)).toBe('0');
      expect(formatChallengeId(id)).toBe(challenge);
    });

    it('verifyLinkCode sends a step up code to the step up check for the signed in session', async () => {
      const flow = await signedUpFlow();
      const { email, b, session, sent, challenge } = await stepUpMail(flow);
      await h.sql(
        `update app.sessions set authenticated_at = now() - interval '1 hour' where id = '${session.sessionId}';`,
      );
      const before = await sessionsOf(email);
      const result = await flow.signIn.verifyLinkCode(b.context(), session, {
        challenge,
        code: sent.code,
      });
      if (!result.ok) throw result.error;
      expect(result.value.kind).toBe('stepped_up');
      expect(await sessionsOf(email)).toBe(before);
      await expect(flow.sessions.requireRecentAuth(session)).resolves.toMatchObject({ ok: true });
    });

    it('verifyLinkCode refuses a step up code with no session, and signs in from a sign in code', async () => {
      const flow = await signedUpFlow();
      const { email, b, sent, challenge } = await stepUpMail(flow);
      const before = await sessionsOf(email);
      const signedOut = await flow.signIn.verifyLinkCode(b.context(), null, {
        challenge,
        code: sent.code,
      });
      expect(!signedOut.ok && signedOut.error.code).toBe('AUTH_CHALLENGE_BINDING');
      expect(await sessionsOf(email)).toBe(before);

      const other = address('link');
      await h.user(other);
      const fresh_ = newBrowser();
      const mail = await requestCode(flow, fresh_, other);
      if (mail === null) throw new Error('no mail');
      const signedIn = await flow.signIn.verifyLinkCode(fresh_.context(), null, mail);
      if (!signedIn.ok) throw signedIn.error;
      expect(signedIn.value.kind).toBe('signed_in');
    });
  });
});
