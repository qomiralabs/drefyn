import { toPublicId } from '@drefyn/tenancy';
import { organizationId } from '@drefyn/tenancy';
import { describe, expect, it, vi } from 'vitest';
import {
  AuthError,
  REDACTED,
  redact,
  serializeCookie,
  sessionCookieValue,
  type AuthMailer,
} from '../src/index.ts';
import {
  AUTHENTICATED_AT,
  OTHER_SESSION,
  OTHER_USER,
  SECRET,
  SESSION,
  USER,
  browser,
  config,
  isProof,
  loopbackConfig,
  sessionInfo,
  sessionResponder,
  sessionRow,
  setup,
  sha,
  tokenFor,
} from './session-fixtures.ts';
import type { Statement } from './scripted-store.ts';
import { UUID_A } from './support.ts';

const DAY = 86_400;

describe('cookies', () => {
  it('writes the secure session cookie with exact flags', () => {
    const header = serializeCookie(config, {
      name: config.cookies.session,
      value: tokenFor(),
      maxAgeSeconds: 30 * DAY,
    });
    expect(header).toBe(
      `__Host-drefyn_session=${tokenFor()}; Path=/; Max-Age=${String(30 * DAY)}; HttpOnly; Secure; SameSite=Lax`,
    );
  });

  it('drops Secure and the prefix only on the loopback setup', () => {
    const header = serializeCookie(loopbackConfig, {
      name: loopbackConfig.cookies.session,
      value: tokenFor(),
      maxAgeSeconds: 60,
    });
    expect(header).toBe(`drefyn_session=${tokenFor()}; Path=/; Max-Age=60; HttpOnly; SameSite=Lax`);
  });

  it('clears with an empty value and Max-Age=0', () => {
    expect(serializeCookie(config, { name: config.cookies.pre, value: '', maxAgeSeconds: 0 })).toBe(
      '__Host-drefyn_pre=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    );
  });

  it('refuses a name auth does not own and a value outside the token alphabet', () => {
    expect(() => serializeCookie(config, { name: 'other', value: 'x', maxAgeSeconds: 1 })).toThrow(
      RangeError,
    );
    expect(() =>
      serializeCookie(config, { name: config.cookies.session, value: 'a;b', maxAgeSeconds: 1 }),
    ).toThrow(RangeError);
    expect(() =>
      serializeCookie(config, { name: config.cookies.session, value: 'a', maxAgeSeconds: -1 }),
    ).toThrow(RangeError);
    expect(() =>
      serializeCookie(config, { name: config.cookies.session, value: 'a', maxAgeSeconds: 1.5 }),
    ).toThrow(RangeError);
  });

  it('reads only the prefixed cookie when cookies are secure', () => {
    const value = tokenFor();
    expect(sessionCookieValue(config, new Map([['drefyn_session', value]]))).toBeUndefined();
    expect(sessionCookieValue(config, new Map([['__Host-drefyn_session', value]]))).toBe(value);
  });

  it('reads the bare cookie only on the loopback setup', () => {
    const value = tokenFor();
    expect(sessionCookieValue(loopbackConfig, new Map([['drefyn_session', value]]))).toBe(value);
    expect(
      sessionCookieValue(loopbackConfig, new Map([['__Host-drefyn_session', value]])),
    ).toBeUndefined();
  });
});

describe('resolve', () => {
  it('returns the session with database expiry and step up fields', async () => {
    const { sessions } = setup(
      sessionResponder([sessionRow({ method: 'password', step_up_method: 'email' })]),
    );
    const info = await sessions.resolveSession(tokenFor());
    expect(info).toEqual({
      sessionId: SESSION,
      userId: USER,
      email: 'person@example.com',
      authenticatedAt: AUTHENTICATED_AT,
      expiresAt: new Date('2026-11-30T10:00:00.000Z'),
      method: 'password',
      stepUpMethod: 'email',
    });
  });

  it('leaves stepUpMethod off when the session never stepped up', async () => {
    const { sessions } = setup();
    const info = await sessions.resolveSession(tokenFor());
    expect(info !== null && 'stepUpMethod' in info).toBe(false);
  });

  it('hands the idle limit to the database instead of comparing app clocks', async () => {
    const { sessions, scripted } = setup();
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-01-01T00:00:00Z'));
    await expect(sessions.resolveSession(tokenFor())).resolves.not.toBeNull();
    now.mockRestore();
    const [proof] = scripted.statements();
    expect(proof?.sql).toMatch(/now\(\)/);
    expect(proof?.parameters).toContain(7);
  });

  it('says a touch is due when the row says so, and writes nothing itself', async () => {
    const { sessions, scripted } = setup(sessionResponder([sessionRow({ touch_due: true })]));
    const resolved = await sessions.resolve(tokenFor());
    expect(resolved?.touchDue).toBe(true);
    expect(scripted.writes()).toEqual([]);
  });

  it('says no touch is due inside the hour', async () => {
    const { sessions } = setup();
    expect((await sessions.resolve(tokenFor()))?.touchDue).toBe(false);
  });

  it('runs under the user the cookie names', async () => {
    const { sessions, scripted } = setup();
    await sessions.resolveSession(tokenFor());
    expect(scripted.events[0]).toEqual({ kind: 'begin', scope: 'user', userId: USER });
  });

  it('throws AUTH_UNAVAILABLE when the database fails, so the guard does not sign out', async () => {
    const { sessions } = setup(() => {
      throw new Error('connection refused');
    });
    await expect(sessions.resolveSession(tokenFor())).rejects.toMatchObject({
      code: 'AUTH_UNAVAILABLE',
    });
  });

  it('refuses a row whose user differs from the cookie, even with the right secret', async () => {
    const { sessions } = setup(sessionResponder([sessionRow({ user_id: OTHER_USER })]));
    await expect(sessions.resolveSession(tokenFor())).resolves.toBeNull();
  });

  it('refuses a stored method it does not know', async () => {
    const { sessions } = setup(sessionResponder([sessionRow({ method: 'saml' })]));
    await expect(sessions.resolveSession(tokenFor())).rejects.toMatchObject({
      code: 'AUTH_UNAVAILABLE',
    });
  });
});

describe('touchSession', () => {
  it('sends one guarded update under the user', async () => {
    const { sessions, scripted } = setup();
    await sessions.touchSession({ userId: USER, sessionId: SESSION });
    const [update] = scripted.statements();
    expect(scripted.statements()).toHaveLength(1);
    expect(update?.sql).toMatch(/^update "sessions" set "last_seen_at" = now\(\)/);
    expect(update?.sql).toMatch(/"id" = \$1/);
    expect(update?.sql).toMatch(/"user_id" = app\.current_user_id\(\)/);
    expect(update?.sql).toMatch(/"last_seen_at" < now\(\) - interval '1 hour'/);
    expect(update?.parameters).toEqual([SESSION]);
    expect(scripted.events[0]).toEqual({ kind: 'begin', scope: 'user', userId: USER });
  });

  it('never throws, and logs the ids only', async () => {
    const { sessions, lines } = setup(() => {
      throw new Error(`boom ${tokenFor()}`);
    });
    const org = organizationId('01890a5d-ac96-774b-bcce-b302099a8070');
    await expect(
      sessions.touchSession({ userId: USER, sessionId: SESSION, organizationId: org }),
    ).resolves.toBeUndefined();
    expect(lines).toEqual([
      {
        event: 'auth.session_touch_failed',
        fields: {
          organizationId: toPublicId('org', org),
          userId: toPublicId('usr', USER),
          sessionId: toPublicId('ses', SESSION),
        },
      },
    ]);
  });

  it('never throws when the logger throws too', async () => {
    const { sessions } = setup(
      () => {
        throw new Error('down');
      },
      {
        logger: {
          warn() {
            throw new Error('logger down');
          },
        },
      },
    );
    await expect(
      sessions.touchSession({ userId: USER, sessionId: SESSION }),
    ).resolves.toBeUndefined();
  });

  it('never throws for ids that are not ids', async () => {
    const { sessions, lines } = setup();
    await expect(
      sessions.touchSession({ userId: 'nope' as typeof USER, sessionId: SESSION }),
    ).resolves.toBeUndefined();
    expect(lines.map((l) => l.event)).toEqual(['auth.session_touch_failed']);
    expect(lines[0]?.fields).toEqual({ sessionId: toPublicId('ses', SESSION) });
  });
});

const isInsert = (s: Statement) => /^insert into "sessions"/.test(s.sql);
const isDelete = (s: Statement) => /^delete from "sessions"/.test(s.sql);

function startResponder(oldRows: readonly Record<string, unknown>[]) {
  const proof = sessionResponder(oldRows);
  return (s: Statement) => {
    if (isInsert(s)) {
      return [
        { id: OTHER_SESSION, authenticated_at: AUTHENTICATED_AT, expires_at: AUTHENTICATED_AT },
      ];
    }
    if (isDelete(s)) return [{ id: SESSION }];
    return proof(s);
  };
}

describe('startSession', () => {
  it('creates a row with a fresh secret and database times, and sets the cookie', async () => {
    const { sessions, scripted } = setup(startResponder([]));
    const started = await sessions.startSession(browser(), {
      userId: OTHER_USER,
      method: 'google',
    });
    const insert = scripted.statements().find(isInsert);
    expect(insert?.sql).toMatch(/now\(\)/);
    expect(insert?.parameters).toContain('google');
    expect(insert?.parameters).toContain(30);
    expect(insert?.parameters).toContainEqual(sha(Buffer.alloc(32, 5)));
    expect(started.session).toMatchObject({
      sessionId: OTHER_SESSION,
      userId: OTHER_USER,
      method: 'google',
    });
    const cookie = started.setCookies.find((c) => c.name === config.cookies.session);
    expect(cookie?.maxAgeSeconds).toBe(30 * DAY);
    expect(cookie?.value).toBe(tokenFor(OTHER_USER, OTHER_SESSION, Buffer.alloc(32, 5)));
  });

  it('clears the pre sign in cookies so nothing chosen before sign in survives it', async () => {
    const { sessions } = setup(startResponder([]));
    const started = await sessions.startSession(browser(), { userId: USER, method: 'email' });
    const cleared = started.setCookies.filter((c) => c.maxAgeSeconds === 0).map((c) => c.name);
    expect(cleared.sort()).toEqual([config.cookies.oauth, config.cookies.pre].sort());
  });

  it('deletes the previous row when another user signs in in the same browser', async () => {
    const { sessions, scripted } = setup(startResponder([sessionRow()]));
    await sessions.startSession(browser({ [config.cookies.session]: tokenFor() }), {
      userId: OTHER_USER,
      method: 'email',
    });
    const begins = scripted.events.filter((e) => e.kind === 'begin');
    expect(begins[0]).toEqual({ kind: 'begin', scope: 'user', userId: USER });
    const deletes = scripted.statements().filter(isDelete);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.parameters).toEqual([SESSION]);
    // The proof comes first, then the delete, in the old user's transaction.
    const firstTwo = scripted.statements().slice(0, 2);
    expect(firstTwo[0] !== undefined && isProof(firstTwo[0])).toBe(true);
    expect(firstTwo[1] !== undefined && isDelete(firstTwo[1])).toBe(true);
  });

  it('replaces the previous row for the same user too', async () => {
    const { sessions, scripted } = setup(startResponder([sessionRow()]));
    await sessions.startSession(browser({ [config.cookies.session]: tokenFor() }), {
      userId: USER,
      method: 'email',
    });
    expect(scripted.statements().filter(isDelete)).toHaveLength(1);
  });

  it('deletes nothing when the old cookie does not prove its row', async () => {
    const { sessions, scripted } = setup(
      startResponder([sessionRow({ secret: Buffer.alloc(32, 1) })]),
    );
    await sessions.startSession(browser({ [config.cookies.session]: tokenFor() }), {
      userId: OTHER_USER,
      method: 'email',
    });
    expect(scripted.statements().filter(isDelete)).toEqual([]);
  });

  it('truncates the user agent to 256 characters', async () => {
    const { sessions, scripted } = setup(startResponder([]));
    const long = { ...browser(), userAgent: '\u{1F600}'.repeat(300) };
    await sessions.startSession(long, { userId: USER, method: 'email' });
    const insert = scripted.statements().find(isInsert);
    const agent = insert?.parameters.find(
      (p) => typeof p === 'string' && p.startsWith('\u{1F600}'),
    );
    expect(Array.from(agent as string)).toHaveLength(256);
  });

  it('stores no user agent when there is none', async () => {
    const { sessions, scripted } = setup(startResponder([]));
    await sessions.startSession({ ...browser(), userAgent: '' }, { userId: USER, method: 'email' });
    expect(scripted.statements().find(isInsert)?.parameters).toContain(null);
  });

  it('fails with AUTH_UNAVAILABLE when the insert fails', async () => {
    const { sessions } = setup((s) => {
      if (isInsert(s)) throw new Error('down');
      return [];
    });
    await expect(
      sessions.startSession(browser(), { userId: USER, method: 'email' }),
    ).rejects.toMatchObject({
      code: 'AUTH_UNAVAILABLE',
    });
  });
});

describe('sign out and revocation', () => {
  it('signOut deletes the one row and clears the cookie', async () => {
    const { sessions, scripted } = setup(() => [{ id: SESSION }]);
    const cookies = await sessions.signOut(sessionInfo());
    const [del] = scripted.statements();
    expect(del?.sql).toMatch(/^delete from "sessions" where "id" = \$1/);
    expect(del?.parameters).toEqual([SESSION]);
    expect(cookies).toEqual([{ name: config.cookies.session, value: '', maxAgeSeconds: 0 }]);
  });

  it('signOutEverywhere deletes every row of the user and counts them', async () => {
    const { sessions, scripted } = setup(() => [{ id: SESSION }, { id: OTHER_SESSION }]);
    await expect(sessions.signOutEverywhere(sessionInfo())).resolves.toBe(2);
    const [del] = scripted.statements();
    expect(del?.sql).toMatch(/^delete from "sessions" where "user_id" = app\.current_user_id\(\)/);
    expect(scripted.events[0]).toEqual({ kind: 'begin', scope: 'user', userId: USER });
  });

  it('listSessions returns live rows with the current one marked', async () => {
    const seen = new Date('2026-10-31T11:00:00.000Z');
    const { sessions, scripted } = setup(() => [
      {
        id: SESSION,
        method: 'email',
        user_agent: 'A',
        created_at: AUTHENTICATED_AT,
        last_seen_at: seen,
      },
      {
        id: OTHER_SESSION,
        method: 'github',
        user_agent: null,
        created_at: AUTHENTICATED_AT,
        last_seen_at: seen,
      },
    ]);
    const list = await sessions.listSessions(sessionInfo());
    expect(list).toEqual([
      {
        sessionId: SESSION,
        method: 'email',
        userAgent: 'A',
        createdAt: AUTHENTICATED_AT,
        lastSeenAt: seen,
        current: true,
      },
      {
        sessionId: OTHER_SESSION,
        method: 'github',
        userAgent: null,
        createdAt: AUTHENTICATED_AT,
        lastSeenAt: seen,
        current: false,
      },
    ]);
    const [select] = scripted.statements();
    expect(select?.sql).toMatch(/now\(\)/);
    expect(select?.sql).not.toMatch(/secret_hash/);
  });

  it('revokeSession deletes one row and says when there was none', async () => {
    const hit = setup(() => [{ id: OTHER_SESSION }]);
    await expect(hit.sessions.revokeSession(sessionInfo(), OTHER_SESSION)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(hit.scripted.statements()[0]?.parameters).toEqual([OTHER_SESSION]);
    const miss = setup(() => []);
    const result = await miss.sessions.revokeSession(sessionInfo(), OTHER_SESSION);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('AUTH_NOT_FOUND');
  });

  it('maps database failures to AUTH_UNAVAILABLE', async () => {
    const { sessions } = setup(() => {
      throw new Error('down');
    });
    await expect(sessions.signOut(sessionInfo())).rejects.toMatchObject({
      code: 'AUTH_UNAVAILABLE',
    });
    await expect(sessions.signOutEverywhere(sessionInfo())).rejects.toMatchObject({
      code: 'AUTH_UNAVAILABLE',
    });
    await expect(sessions.listSessions(sessionInfo())).rejects.toMatchObject({
      code: 'AUTH_UNAVAILABLE',
    });
    const revoked = await sessions.revokeSession(sessionInfo(), OTHER_SESSION);
    expect(!revoked.ok && revoked.error.code).toBe('AUTH_UNAVAILABLE');
  });
});

describe('recent sign in', () => {
  it('passes inside 15 minutes by the database clock', async () => {
    const { sessions, scripted } = setup(() => [{ recent: true }]);
    await expect(sessions.requireRecentAuth(sessionInfo())).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    const [select] = scripted.statements();
    expect(select?.sql).toMatch(/now\(\) - interval '15 minutes'/);
  });

  it('returns AUTH_RECENT_AUTH_REQUIRED outside 15 minutes', async () => {
    const { sessions } = setup(() => [{ recent: false }]);
    const result = await sessions.requireRecentAuth(sessionInfo());
    expect(!result.ok && result.error.code).toBe('AUTH_RECENT_AUTH_REQUIRED');
  });

  it('returns AUTH_SESSION_INVALID when the session is gone', async () => {
    const { sessions } = setup(() => []);
    const result = await sessions.requireRecentAuth(sessionInfo());
    expect(!result.ok && result.error.code).toBe('AUTH_SESSION_INVALID');
  });
});

const isStepUpWrite = (s: Statement) =>
  /^update "sessions" set "authenticated_at" = now\(\)/.test(s.sql);
const isPhcRead = (s: Statement) => /from "password_credentials"/.test(s.sql);

function stepUpResponder(phc: string | null = '$argon2id$stored') {
  return (s: Statement) => {
    if (isPhcRead(s)) return phc === null ? [] : [{ phc }];
    if (isStepUpWrite(s)) return [{ authenticated_at: new Date('2026-10-31T12:00:00.000Z') }];
    return [];
  };
}

describe('step up by current password', () => {
  it('counts against password_fail before the hash, verifies outside any transaction, and records the method', async () => {
    const order: string[] = [];
    let openDuringVerify = -1;
    const verify = vi.fn((phc: string | null, password: string) => {
      order.push('verify');
      openDuringVerify = scripted.open;
      return Promise.resolve(phc === '$argon2id$stored' && password === 'right horse battery');
    });
    const { sessions, scripted, limiter } = setup(stepUpResponder(), { passwords: { verify } });
    const reserve = limiter.reserve.bind(limiter);
    limiter.reserve = (bucket, value) => {
      order.push(bucket);
      return reserve(bucket, value);
    };
    const result = await sessions.stepUpWithPassword(browser(), sessionInfo(), {
      password: 'right horse battery',
    });
    expect(result).toEqual({
      ok: true,
      value: {
        ...sessionInfo(),
        authenticatedAt: new Date('2026-10-31T12:00:00.000Z'),
        stepUpMethod: 'password',
      },
    });
    expect(order).toEqual(['password_fail', 'password_fail_ip', 'verify']);
    expect(limiter.calls[0]).toEqual(['password_fail', ['person@example.com']]);
    expect(openDuringVerify).toBe(0);
    const write = scripted.statements().find(isStepUpWrite);
    expect(write?.sql).toMatch(/"step_up_method" = \$1/);
    expect(write?.parameters).toEqual(['password', SESSION]);
  });

  it('refuses a wrong password with AUTH_CREDENTIALS_INVALID and writes nothing', async () => {
    const { sessions, scripted } = setup(stepUpResponder(), {
      passwords: { verify: () => Promise.resolve(false) },
    });
    const result = await sessions.stepUpWithPassword(browser(), sessionInfo(), {
      password: 'wrong',
    });
    expect(!result.ok && result.error.code).toBe('AUTH_CREDENTIALS_INVALID');
    expect(scripted.writes()).toEqual([]);
  });

  it('still verifies against nothing when the user has no password', async () => {
    const verify = vi.fn(() => Promise.resolve(false));
    const { sessions } = setup(stepUpResponder(null), { passwords: { verify } });
    const result = await sessions.stepUpWithPassword(browser(), sessionInfo(), { password: 'x' });
    expect(verify).toHaveBeenCalledWith(null, 'x');
    expect(!result.ok && result.error.code).toBe('AUTH_CREDENTIALS_INVALID');
  });

  it('returns AUTH_RATE_LIMITED before any hash when the bucket is full', async () => {
    const verify = vi.fn(() => Promise.resolve(true));
    const { sessions, limiter } = setup(stepUpResponder(), { passwords: { verify } });
    limiter.reserve = () =>
      Promise.reject(new AuthError('AUTH_RATE_LIMITED', { retryAfterSeconds: 60 }));
    const result = await sessions.stepUpWithPassword(browser(), sessionInfo(), { password: 'x' });
    expect(!result.ok && result.error.code).toBe('AUTH_RATE_LIMITED');
    expect(!result.ok && result.error.retryAfterSeconds).toBe(60);
    expect(verify).not.toHaveBeenCalled();
  });

  it('returns AUTH_PASSWORDS_DISABLED when passwords are off or no verifier is wired', async () => {
    const off = setup(
      stepUpResponder(),
      {
        passwords: { verify: () => Promise.resolve(true) },
      },
      { ...config, passwords: { ...config.passwords, enabled: false } },
    );
    const a = await off.sessions.stepUpWithPassword(browser(), sessionInfo(), { password: 'x' });
    expect(!a.ok && a.error.code).toBe('AUTH_PASSWORDS_DISABLED');
    const unwired = setup(stepUpResponder());
    const b = await unwired.sessions.stepUpWithPassword(browser(), sessionInfo(), {
      password: 'x',
    });
    expect(!b.ok && b.error.code).toBe('AUTH_PASSWORDS_DISABLED');
  });

  it('refuses a password over 4 KiB before counting or reading anything', async () => {
    const { sessions, scripted, limiter } = setup(stepUpResponder(), {
      passwords: { verify: () => Promise.resolve(true) },
    });
    const result = await sessions.stepUpWithPassword(browser(), sessionInfo(), {
      password: 'a'.repeat(4097),
    });
    expect(!result.ok && result.error.code).toBe('AUTH_INPUT_INVALID');
    expect(limiter.calls).toEqual([]);
    expect(scripted.events).toEqual([]);
  });

  it('returns AUTH_SESSION_INVALID when the session went away during the hash', async () => {
    const { sessions } = setup((s) => (isPhcRead(s) ? [{ phc: 'p' }] : []), {
      passwords: { verify: () => Promise.resolve(true) },
    });
    const result = await sessions.stepUpWithPassword(browser(), sessionInfo(), { password: 'x' });
    expect(!result.ok && result.error.code).toBe('AUTH_SESSION_INVALID');
  });

  it('maps a verifier failure to AUTH_UNAVAILABLE', async () => {
    const { sessions } = setup(stepUpResponder(), {
      passwords: { verify: () => Promise.reject(new Error('pool exhausted')) },
    });
    const result = await sessions.stepUpWithPassword(browser(), sessionInfo(), { password: 'x' });
    expect(!result.ok && result.error.code).toBe('AUTH_UNAVAILABLE');
  });
});

const isChallengeInsert = (s: Statement) => /^insert into "email_challenges"/.test(s.sql);
const isChallengeDelete = (s: Statement) => /^delete from "email_challenges"/.test(s.sql);
const isAttempt = (s: Statement) =>
  /^update "email_challenges" set "attempts" = "attempts" \+ 1/.test(s.sql);
const isConsume = (s: Statement) =>
  /^update "email_challenges" set "consumed_at" = now\(\)/.test(s.sql);

function mailer() {
  const sent: { to: string; code: string; link: URL; purpose: string }[] = [];
  const m: AuthMailer = {
    sendSignInCode(to, code, link, purpose) {
      sent.push({ to, code, link, purpose });
      return Promise.resolve();
    },
  };
  return { mailer: m, sent };
}

describe('step up by email code', () => {
  it('stores a step up challenge bound to the session and mails the code after the response', async () => {
    const { mailer: m, sent } = mailer();
    const { sessions, scripted, limiter } = setup(() => [], { mailer: m });
    const started = await sessions.startStepUpCode(browser(), sessionInfo());
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(sent).toEqual([]);
    expect(limiter.calls.map(([bucket]) => bucket)).toEqual(['email_send', 'email_send_ip']);
    const insert = scripted.statements().find(isChallengeInsert);
    expect(insert?.parameters).toContain('step_up');
    expect(insert?.parameters).toContain('person@example.com');
    expect(insert?.parameters).toContain(USER);
    expect(insert?.sql).toMatch(/now\(\) \+ interval '10 minutes'/);
    // Older step up challenges from the same session go first.
    const statements = scripted.statements();
    expect(statements.findIndex(isChallengeDelete)).toBeLessThan(
      statements.findIndex(isChallengeInsert),
    );
    expect(scripted.events[0]).toEqual({ kind: 'begin', scope: 'auth' });
    await started.value.send();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.purpose).toBe('step_up');
    expect(sent[0]?.to).toBe('person@example.com');
    expect(sent[0]?.code).toMatch(/^[0-9]{8}$/);
    expect(sent[0]?.link.origin).toBe('https://app.drefyn.test');
    expect(sent[0]?.link.pathname).toBe('/sign-in/verify');
    expect(sent[0]?.link.hash).toBe(`#${started.value.challenge}.${sent[0]?.code ?? ''}`);
    // The stored HMAC never equals a plain hash of the code.
    expect(insert?.parameters).not.toContainEqual(sha(Buffer.from(sent[0]?.code ?? '')));
  });

  it('logs a failed send with ids only and never throws from send', async () => {
    const { sessions, lines } = setup(() => [], {
      mailer: {
        sendSignInCode: () => Promise.reject(new Error('smtp person@example.com down')),
      },
    });
    const started = await sessions.startStepUpCode(browser(), sessionInfo());
    if (!started.ok) throw new Error('expected a start');
    await expect(started.value.send()).resolves.toBeUndefined();
    expect(lines).toEqual([
      {
        event: 'auth.step_up_mail_failed',
        fields: { userId: toPublicId('usr', USER), sessionId: toPublicId('ses', SESSION) },
      },
    ]);
  });

  it('returns AUTH_UNAVAILABLE with no mailer wired, before counting anything', async () => {
    const { sessions, limiter } = setup(() => []);
    const started = await sessions.startStepUpCode(browser(), sessionInfo());
    expect(!started.ok && started.error.code).toBe('AUTH_UNAVAILABLE');
    expect(limiter.calls).toEqual([]);
  });

  async function startAndCapture() {
    const { mailer: m, sent } = mailer();
    const ctx = setup(() => [], { mailer: m });
    const started = await ctx.sessions.startStepUpCode(browser(), sessionInfo());
    if (!started.ok) throw new Error('expected a start');
    await started.value.send();
    const insert = ctx.scripted.statements().find(isChallengeInsert);
    return { ...ctx, challenge: started.value.challenge, code: sent[0]?.code ?? '', insert };
  }

  it('verifies the code, consumes the challenge and records email as the step up', async () => {
    const { sessions, scripted, challenge, code, insert } = await startAndCapture();
    const params = insert?.parameters ?? [];
    const buffers = params.filter((p): p is Buffer => Buffer.isBuffer(p));
    scripted.clear();
    scripted.respondWith((s) => {
      if (isAttempt(s)) return [{ code_hmac: buffers[0], user_id: USER }];
      if (isConsume(s)) return [{ id: 'x' }];
      if (isStepUpWrite(s)) return [{ authenticated_at: new Date('2026-10-31T12:00:00.000Z') }];
      return [];
    });
    const result = await sessions.verifyStepUpCode(browser(), sessionInfo(), {
      challenge,
      code: `${code.slice(0, 4)} ${code.slice(4)}`,
    });
    expect(result).toEqual({
      ok: true,
      value: {
        ...sessionInfo(),
        authenticatedAt: new Date('2026-10-31T12:00:00.000Z'),
        stepUpMethod: 'email',
      },
    });
    const attempt = scripted.statements().find(isAttempt);
    expect(attempt?.sql).toMatch(/"attempts" < \$/);
    expect(attempt?.sql).toMatch(/"consumed_at" is null/);
    expect(attempt?.sql).toMatch(/"expires_at" > now\(\)/);
    expect(attempt?.parameters).toContainEqual(buffers[1]);
    expect(scripted.statements().find(isStepUpWrite)?.parameters).toEqual(['email', SESSION]);
  });

  it('keeps the attempt and consumes nothing on a wrong code', async () => {
    const { sessions, scripted, challenge, code, insert } = await startAndCapture();
    const buffers = (insert?.parameters ?? []).filter((p): p is Buffer => Buffer.isBuffer(p));
    scripted.clear();
    scripted.respondWith((s) => (isAttempt(s) ? [{ code_hmac: buffers[0], user_id: USER }] : []));
    const wrong = code === '00000000' ? '00000001' : '00000000';
    const result = await sessions.verifyStepUpCode(browser(), sessionInfo(), {
      challenge,
      code: wrong,
    });
    expect(!result.ok && result.error.code).toBe('AUTH_CODE_INVALID');
    expect(scripted.statements().filter(isConsume)).toEqual([]);
    expect(scripted.statements().filter(isStepUpWrite)).toEqual([]);
    expect(scripted.events.at(-1)).toEqual({ kind: 'commit' });
  });

  it('refuses an unknown, used, expired or foreign challenge with AUTH_CODE_INVALID', async () => {
    const { sessions, scripted, challenge, code } = await startAndCapture();
    scripted.respondWith(() => []);
    const result = await sessions.verifyStepUpCode(browser(), sessionInfo(), { challenge, code });
    expect(!result.ok && result.error.code).toBe('AUTH_CODE_INVALID');
  });

  it('refuses a challenge stored for another user', async () => {
    const { sessions, scripted, challenge, code, insert } = await startAndCapture();
    const buffers = (insert?.parameters ?? []).filter((p): p is Buffer => Buffer.isBuffer(p));
    scripted.respondWith((s) =>
      isAttempt(s) ? [{ code_hmac: buffers[0], user_id: UUID_A.replace('7', '8') }] : [],
    );
    const result = await sessions.verifyStepUpCode(browser(), sessionInfo(), { challenge, code });
    expect(!result.ok && result.error.code).toBe('AUTH_CODE_INVALID');
  });

  it('refuses malformed input before any count or statement', async () => {
    const { sessions, scripted, limiter } = setup(() => []);
    for (const input of [
      { challenge: 'x', code: '12345678' },
      { challenge: '0'.repeat(26), code: '1234567' },
      { challenge: '0'.repeat(26), code: '1234-5678' },
    ]) {
      const result = await sessions.verifyStepUpCode(browser(), sessionInfo(), input);
      expect(!result.ok && result.error.code).toBe('AUTH_CODE_INVALID');
    }
    expect(limiter.calls).toEqual([]);
    expect(scripted.events).toEqual([]);
  });

  it('counts code_verify on the address and the session binding before the attempt', async () => {
    const { sessions, scripted, limiter, challenge, code } = await startAndCapture();
    limiter.calls.splice(0);
    scripted.respondWith(() => []);
    await sessions.verifyStepUpCode(browser(), sessionInfo(), { challenge, code });
    expect(limiter.calls.map(([bucket]) => bucket)).toEqual(['code_verify']);
    expect(limiter.calls[0]?.[1][0]).toBe('person@example.com');
  });

  it('returns AUTH_SESSION_INVALID when the session went away before the write', async () => {
    const { sessions, scripted, challenge, code, insert } = await startAndCapture();
    const buffers = (insert?.parameters ?? []).filter((p): p is Buffer => Buffer.isBuffer(p));
    scripted.respondWith((s) => {
      if (isAttempt(s)) return [{ code_hmac: buffers[0], user_id: USER }];
      if (isConsume(s)) return [{ id: 'x' }];
      return [];
    });
    const result = await sessions.verifyStepUpCode(browser(), sessionInfo(), { challenge, code });
    expect(!result.ok && result.error.code).toBe('AUTH_SESSION_INVALID');
  });

  it('refuses a second redemption that lost the consume race', async () => {
    const { sessions, scripted, challenge, code, insert } = await startAndCapture();
    const buffers = (insert?.parameters ?? []).filter((p): p is Buffer => Buffer.isBuffer(p));
    scripted.respondWith((s) => (isAttempt(s) ? [{ code_hmac: buffers[0], user_id: USER }] : []));
    const result = await sessions.verifyStepUpCode(browser(), sessionInfo(), { challenge, code });
    expect(!result.ok && result.error.code).toBe('AUTH_CODE_INVALID');
  });

  it('maps a database failure to AUTH_UNAVAILABLE', async () => {
    const { mailer: m } = mailer();
    const { sessions } = setup(
      () => {
        throw new Error('down');
      },
      { mailer: m },
    );
    const started = await sessions.startStepUpCode(browser(), sessionInfo());
    expect(!started.ok && started.error.code).toBe('AUTH_UNAVAILABLE');
  });
});

describe('logs', () => {
  it('never carry a session token, a secret, a code or an address', async () => {
    const token = tokenFor();
    const { sessions, lines } = setup(
      () => {
        throw new Error(`failed for ${token} person@example.com`);
      },
      {
        mailer: { sendSignInCode: () => Promise.reject(new Error(`code 12345678 for ${token}`)) },
      },
    );
    await sessions.touchSession({ userId: USER, sessionId: SESSION });
    await sessions.resolveSession(token).catch(() => undefined);
    const ok = setup(() => [], {
      mailer: { sendSignInCode: () => Promise.reject(new Error(`code for ${token}`)) },
    });
    const started = await ok.sessions.startStepUpCode(browser(), sessionInfo());
    if (started.ok) await started.value.send();
    const text = JSON.stringify([...lines, ...ok.lines]);
    expect(text).not.toContain(token);
    expect(text).not.toContain(SECRET.toString('hex'));
    expect(text).not.toContain('person@example.com');
    expect(text).not.toMatch(/[0-9]{8}/);
    expect(lines.length + ok.lines.length).toBeGreaterThan(0);
  });

  it('a session cookie in any log value is redacted', () => {
    const token = tokenFor();
    const out = JSON.stringify(
      redact({ header: `__Host-drefyn_session=${token}; Path=/`, value: token, nested: { token } }),
    );
    expect(out).not.toContain(token);
    expect(out).toContain(REDACTED);
  });
});
