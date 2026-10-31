import { withUser } from '@drefyn/db';
import { beforeAll, expect, it } from 'vitest';
import type { AuthMailer, CookieSpec, PasswordVerifier } from '../../src/index.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';

const fresh = harness();
let h: Harness;

const browser = () => ({
  ip: '198.51.100.4',
  userAgent: 'StepUp/1.0',
  cookies: new Map<string, string>(),
});

// Stands in for the Argon2id verifier the passwords issue brings: the stored value is the
// password with a marker, so the test controls right and wrong without hashing.
const verifier: PasswordVerifier = {
  verify: (phc, password) => Promise.resolve(phc === `test$${password}`),
};

function inbox() {
  const sent: { to: string; code: string; link: URL; purpose: string }[] = [];
  const mailer: AuthMailer = {
    sendSignInCode(to, code, link, purpose) {
      sent.push({ to, code, link, purpose });
      return Promise.resolve();
    },
  };
  return { mailer, sent };
}

async function signedIn(extra: Parameters<Harness['sessions']>[0] = {}) {
  const sessions = h.sessions({ passwords: verifier, ...extra });
  const user = await h.user();
  const started = await sessions.startSession(browser(), { userId: user, method: 'email' });
  const cookie =
    started.setCookies.find((c: CookieSpec) => c.name === h.config.cookies.session)?.value ?? '';
  return { sessions, user, session: started.session, cookie };
}

const age = (sessionId: string, minutes: number) =>
  h.sql(
    `update app.sessions set authenticated_at = now() - interval '${String(minutes)} minutes' where id = '${sessionId}';`,
  );

const stepUpOf = (sessionId: string) =>
  h.sql(
    `select coalesce(step_up_method, '-') || '|' || (authenticated_at > now() - interval '1 minute') from app.sessions where id = '${sessionId}';`,
  );

describeWithStack('step up against Postgres', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  it('a fresh sign in passes, and outside 15 minutes sensitive actions need a recent sign in', async () => {
    const { sessions, session } = await signedIn();
    await expect(sessions.requireRecentAuth(session)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await age(session.sessionId, 16);
    const result = await sessions.requireRecentAuth(session);
    expect(!result.ok && result.error.code).toBe('AUTH_RECENT_AUTH_REQUIRED');
    await age(session.sessionId, 14);
    await expect(sessions.requireRecentAuth(session)).resolves.toMatchObject({ ok: true });
  });

  it('step up by current password refreshes authenticated_at and records the method', async () => {
    const { sessions, session, user, cookie } = await signedIn();
    await withUser(h.db, { userId: user }, (tx) =>
      tx
        .insertInto('password_credentials')
        .values({ user_id: user, phc: 'test$correct horse battery' })
        .execute(),
    );
    await age(session.sessionId, 30);
    const wrong = await sessions.stepUpWithPassword(browser(), session, { password: 'nope' });
    expect(!wrong.ok && wrong.error.code).toBe('AUTH_CREDENTIALS_INVALID');
    expect(await stepUpOf(session.sessionId)).toBe('-|false');
    const right = await sessions.stepUpWithPassword(browser(), session, {
      password: 'correct horse battery',
    });
    expect(right.ok && right.value.stepUpMethod).toBe('password');
    expect(await stepUpOf(session.sessionId)).toBe('password|true');
    await expect(sessions.requireRecentAuth(session)).resolves.toMatchObject({ ok: true });
    await expect(sessions.resolveSession(cookie)).resolves.toMatchObject({
      stepUpMethod: 'password',
    });
  });

  it('password step up counts against password_fail, right or wrong, and stops at the limit', async () => {
    const { sessions, session, user } = await signedIn();
    await withUser(h.db, { userId: user }, (tx) =>
      tx.insertInto('password_credentials').values({ user_id: user, phc: 'test$right' }).execute(),
    );
    const results = [];
    for (let i = 0; i < 10; i += 1) {
      results.push(
        await sessions.stepUpWithPassword(browser(), session, {
          password: i === 9 ? 'right' : 'wrong',
        }),
      );
    }
    expect(
      results.filter((r) => !r.ok && r.error.code === 'AUTH_CREDENTIALS_INVALID'),
    ).toHaveLength(9);
    expect(results[9]?.ok).toBe(true);
    const limited = await sessions.stepUpWithPassword(browser(), session, { password: 'right' });
    expect(!limited.ok && limited.error.code).toBe('AUTH_RATE_LIMITED');
    expect(!limited.ok && (limited.error.retryAfterSeconds ?? 0) > 0).toBe(true);
    const counted = await h.sql(
      `select max(count) from app.auth_rate_limits where bucket = 'password_fail';`,
    );
    expect(Number(counted)).toBeGreaterThanOrEqual(11);
  });

  it('step up by email code refreshes authenticated_at once, and the code is single use', async () => {
    const { mailer, sent } = inbox();
    const { sessions, session } = await signedIn({ mailer });
    await age(session.sessionId, 20);
    const started = await sessions.startStepUpCode(browser(), session);
    if (!started.ok) throw started.error;
    await started.value.send();
    const code = sent[0]?.code ?? '';
    expect(sent[0]?.purpose).toBe('step_up');
    const first = await sessions.verifyStepUpCode(browser(), session, {
      challenge: started.value.challenge,
      code,
    });
    expect(first.ok && first.value.stepUpMethod).toBe('email');
    expect(await stepUpOf(session.sessionId)).toBe('email|true');
    const replay = await sessions.verifyStepUpCode(browser(), session, {
      challenge: started.value.challenge,
      code,
    });
    expect(!replay.ok && replay.error.code).toBe('AUTH_CODE_INVALID');
  });

  it('a challenge allows five attempts, then even the right code fails', async () => {
    const { mailer, sent } = inbox();
    const { sessions, session } = await signedIn({ mailer });
    const started = await sessions.startStepUpCode(browser(), session);
    if (!started.ok) throw started.error;
    await started.value.send();
    const code = sent[0]?.code ?? '';
    const wrong = code === '11111111' ? '22222222' : '11111111';
    for (let i = 0; i < 5; i += 1) {
      const r = await sessions.verifyStepUpCode(browser(), session, {
        challenge: started.value.challenge,
        code: wrong,
      });
      expect(!r.ok && r.error.code).toBe('AUTH_CODE_INVALID');
    }
    const late = await sessions.verifyStepUpCode(browser(), session, {
      challenge: started.value.challenge,
      code,
    });
    expect(!late.ok && late.error.code).toBe('AUTH_CODE_INVALID');
  });

  it('a code from one session does not step up another session of the same user', async () => {
    const { mailer, sent } = inbox();
    const a = await signedIn({ mailer });
    const other = await a.sessions.startSession(browser(), { userId: a.user, method: 'email' });
    const started = await a.sessions.startStepUpCode(browser(), a.session);
    if (!started.ok) throw started.error;
    await started.value.send();
    const result = await a.sessions.verifyStepUpCode(browser(), other.session, {
      challenge: started.value.challenge,
      code: sent[0]?.code ?? '',
    });
    expect(!result.ok && result.error.code).toBe('AUTH_CODE_INVALID');
    // It did not use up an attempt: the right session still redeems it.
    const own = await a.sessions.verifyStepUpCode(browser(), a.session, {
      challenge: started.value.challenge,
      code: sent[0]?.code ?? '',
    });
    expect(own.ok).toBe(true);
  });

  it('an expired challenge is refused by database time', async () => {
    const { mailer, sent } = inbox();
    const { sessions, session } = await signedIn({ mailer });
    const started = await sessions.startStepUpCode(browser(), session);
    if (!started.ok) throw started.error;
    await started.value.send();
    await h.sql(
      `update app.email_challenges set expires_at = now() - interval '1 second' where purpose = 'step_up';`,
    );
    const result = await sessions.verifyStepUpCode(browser(), session, {
      challenge: started.value.challenge,
      code: sent[0]?.code ?? '',
    });
    expect(!result.ok && result.error.code).toBe('AUTH_CODE_INVALID');
  });
});
