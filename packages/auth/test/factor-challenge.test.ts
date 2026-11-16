import { describe, expect, it } from 'vitest';
import { AuthError } from '../src/index.ts';
import {
  CHALLENGE_SECRET,
  RECOVERY,
  STEP,
  challengeRow,
  codeAt,
  credentialRow,
  csrfFor,
  factorBrowser,
  factorConfig,
  factorCookie,
  factorResponder,
  factorSetup,
  isAttemptCount,
  isChallengeDelete,
  isChallengeRead,
  isCredentialRead,
  isFactorLock,
  isFailureWrite,
  isRecoverySpend,
  isSessionInsert,
  isStepWrite,
  keylessConfig,
  type WorldShape,
} from './factor-fixtures.ts';
import { isWrite } from './scripted-store.ts';
import { OTHER_USER, SESSION, USER, tokenFor } from './session-fixtures.ts';

const totp = (code: string = codeAt(STEP)) => ({ kind: 'totp' as const, code, csrf: csrfFor() });
const recovery = (code: string = RECOVERY[0]?.code ?? '') => ({
  kind: 'recovery_code' as const,
  code,
  csrf: csrfFor(),
});

function world(shape: WorldShape = {}, config = factorConfig) {
  return factorSetup(factorResponder(shape), config);
}

const errorCode = (result: { ok: boolean; error?: AuthError }) =>
  result.ok ? 'ok' : result.error?.code;

describe('completeChallenge: nothing before the proof', () => {
  // A stranger knows a user id. Each of these must end after one read, with no lock, no
  // reservation and no write, so the owner's budgets and challenge are untouched.
  it.each([
    ['a wrong secret', { challenge: challengeRow({ secret: Buffer.alloc(32, 1) }) }],
    ['a missing row', { challenge: null }],
    ['an expired row', { challenge: challengeRow({ live: false }) }],
  ])('%s costs one read and nothing else', async (_name, shape) => {
    const { challenges, scripted, limiter } = world(shape);
    const result = await challenges.completeChallenge(factorBrowser(), totp());
    expect(errorCode(result)).toBe('AUTH_FACTOR_CHALLENGE_EXPIRED');
    const statements = scripted.statements();
    expect(statements).toHaveLength(1);
    expect(isChallengeRead(statements[0] ?? { sql: '', parameters: [] })).toBe(true);
    expect(statements.some(isFactorLock)).toBe(false);
    expect(scripted.writes()).toEqual([]);
    expect(limiter.calls).toEqual([]);
  });

  it('reads the challenge by the person alone, with liveness as a flag', async () => {
    const { challenges, scripted } = world({ challenge: null });
    await challenges.completeChallenge(factorBrowser(), totp());
    const [read] = scripted.statements();
    expect(read?.sql).toContain('"user_id" = app.current_user_id()');
    expect(read?.sql).toContain('expires_at > now() and attempts < 5');
    expect(read?.sql).not.toMatch(/for update|for share/);
  });

  it.each([
    ['no cookie', { cookie: undefined }],
    ['a malformed cookie', { cookie: 'v1.nonsense' }],
    ['a session cookie in its place', { cookie: tokenFor() }],
  ])('answers expired with no statement for %s', async (_name, { cookie }) => {
    const { challenges, scripted } = world();
    const cookies = new Map(factorBrowser().cookies);
    if (cookie === undefined) cookies.delete(factorConfig.cookies.factor);
    else cookies.set(factorConfig.cookies.factor, cookie);
    const result = await challenges.completeChallenge({ ...factorBrowser(), cookies }, totp());
    expect(errorCode(result)).toBe('AUTH_FACTOR_CHALLENGE_EXPIRED');
    expect(scripted.statements()).toEqual([]);
  });

  it.each([
    ['five digits', totp('12345')],
    ['letters for a TOTP', totp('abcdef')],
    ['a recovery code too short', recovery('abc')],
    ['a recovery code outside the alphabet', recovery('iiiiii-iiiiii-iiiiii-iiiiii')],
    ['an unknown kind', { kind: 'sms', code: '123456', csrf: csrfFor() }],
  ])('refuses %s as invalid with no statement', async (_name, input) => {
    const { challenges, scripted, limiter } = world();
    // The unknown kind arrives from a form, so the type cannot be trusted.
    const result = await challenges.completeChallenge(
      factorBrowser(),
      input as Parameters<typeof challenges.completeChallenge>[1],
    );
    expect(errorCode(result)).toBe('AUTH_FACTOR_INVALID');
    expect(scripted.statements()).toEqual([]);
    expect(limiter.calls).toEqual([]);
  });

  it('refuses a post without the form binding before anything', async () => {
    const { challenges, scripted } = world();
    const result = await challenges.completeChallenge(factorBrowser(), {
      ...totp(),
      csrf: 'x'.repeat(43),
    });
    expect(errorCode(result)).toBe('AUTH_ORIGIN_REFUSED');
    expect(scripted.statements()).toEqual([]);
  });
});

describe('completeChallenge: the order after the proof', () => {
  it('reserves, then locks shared, counts the attempt, reads the credential and signs in', async () => {
    const { challenges, scripted, limiter } = world();
    const result = await challenges.completeChallenge(factorBrowser(), totp());
    expect(errorCode(result)).toBe('ok');
    expect(limiter.calls).toEqual([['totp_verify', [USER]]]);
    const statements = scripted.statements();
    const at = (match: (s: (typeof statements)[number]) => boolean) => statements.findIndex(match);
    expect(at(isChallengeRead)).toBe(0);
    expect(at(isFactorLock)).toBe(1);
    expect(statements[1]?.sql).toContain('pg_advisory_xact_lock_shared');
    expect(statements[1]?.parameters).toContain(`second_factor:${USER}`);
    expect(at(isAttemptCount)).toBe(2);
    expect(at(isCredentialRead)).toBe(3);
    expect(at(isStepWrite)).toBeGreaterThan(3);
    expect(at(isChallengeDelete)).toBeGreaterThan(at(isStepWrite));
    expect(at(isSessionInsert)).toBeGreaterThan(at(isChallengeDelete));
  });

  it('spends only the challenge it proved', async () => {
    const { challenges, scripted } = world();
    await challenges.completeChallenge(factorBrowser(), totp());
    const count = scripted.statements().find(isAttemptCount);
    expect(count?.sql).toContain('"attempts" < $');
    expect(count?.sql).toContain('"expires_at" > now()');
    expect(count?.sql).toContain('"secret_hash" = $');
    const remove = scripted.statements().find(isChallengeDelete);
    expect(remove?.sql).toContain('"secret_hash" = $');
  });

  it('answers expired when the challenge was replaced after the proof, and signs nobody in', async () => {
    const { challenges, scripted } = world({ attemptCounted: false });
    const result = await challenges.completeChallenge(factorBrowser(), totp());
    expect(errorCode(result)).toBe('AUTH_FACTOR_CHALLENGE_EXPIRED');
    expect(scripted.statements().some(isCredentialRead)).toBe(false);
    expect(scripted.statements().some(isSessionInsert)).toBe(false);
  });

  it('reserves recovery codes on the person and network, and on the network', async () => {
    const { challenges, limiter } = world();
    const result = await challenges.completeChallenge(factorBrowser(), recovery());
    expect(errorCode(result)).toBe('ok');
    expect(limiter.calls.map(([bucket]) => bucket)).toEqual([
      'recovery_code_verify',
      'recovery_code_verify_ip',
    ]);
  });

  it('stops at the limit before the transaction', async () => {
    const { challenges, scripted, limiter, counted } = world();
    limiter.reserve = () => Promise.reject(new AuthError('AUTH_RATE_LIMITED'));
    const result = await challenges.completeChallenge(factorBrowser(), totp());
    expect(errorCode(result)).toBe('AUTH_RATE_LIMITED');
    expect(scripted.statements()).toHaveLength(1);
    expect(counted).toContainEqual({
      name: 'auth.factor',
      labels: { outcome: 'rate_limited', kind: 'totp' },
    });
  });
});

describe('completeChallenge: TOTP', () => {
  it('moves the replay guard only forward and resets the failures', async () => {
    const { challenges, scripted } = world();
    await challenges.completeChallenge(factorBrowser(), totp());
    const write = scripted.statements().find(isStepWrite);
    expect(write?.sql).toContain('"failed_attempts" = $');
    expect(write?.sql).toContain('"last_used_step" is null or "last_used_step" < $');
    expect(write?.parameters).toContain(STEP);
  });

  it('answers a replay as invalid and signs nobody in', async () => {
    const { challenges, scripted } = world({ stepMoved: false });
    const result = await challenges.completeChallenge(factorBrowser(), totp());
    expect(errorCode(result)).toBe('AUTH_FACTOR_INVALID');
    expect(scripted.statements().some(isSessionInsert)).toBe(false);
  });

  it('counts the previous step and says so in the metric', async () => {
    const { challenges, counted } = world();
    const result = await challenges.completeChallenge(factorBrowser(), totp(codeAt(STEP - 1)));
    expect(errorCode(result)).toBe('ok');
    expect(counted).toContainEqual({
      name: 'auth.factor',
      labels: { outcome: 'matched_previous_step', kind: 'totp' },
    });
  });

  it('refuses the next step', async () => {
    const { challenges } = world();
    const result = await challenges.completeChallenge(factorBrowser(), totp(codeAt(STEP + 1)));
    expect(errorCode(result)).toBe('AUTH_FACTOR_INVALID');
  });

  it('saturates the failure count at 100 and commits it', async () => {
    const { challenges, scripted } = world();
    const result = await challenges.completeChallenge(factorBrowser(), totp('000000'));
    expect(errorCode(result)).toBe('AUTH_FACTOR_INVALID');
    const write = scripted.statements().find(isFailureWrite);
    expect(write?.sql).toContain('least("failed_attempts" + 1, 100)');
    expect(scripted.events.at(-1)).toEqual({ kind: 'commit' });
  });

  it('refuses at 100 failures even with the right code', async () => {
    const { challenges, scripted } = world({ credential: credentialRow({ failed: 100 }) });
    const result = await challenges.completeChallenge(factorBrowser(), totp());
    expect(errorCode(result)).toBe('AUTH_FACTOR_DISABLED');
    expect(scripted.statements().some(isStepWrite)).toBe(false);
    expect(scripted.statements().some(isSessionInsert)).toBe(false);
  });

  it('fails closed with no key and logs it, while the row still requires the factor', async () => {
    const { challenges, lines, scripted } = world({}, keylessConfig);
    const result = await challenges.completeChallenge(factorBrowser(keylessConfig), {
      ...totp(),
      csrf: csrfFor(keylessConfig),
    });
    expect(errorCode(result)).toBe('AUTH_UNAVAILABLE');
    expect(lines.map((l) => l.event)).toContain('auth.totp_key_absent');
    expect(scripted.statements().some(isSessionInsert)).toBe(false);
  });

  it('fails closed on a row sealed under an unknown key', async () => {
    const { challenges, lines } = world({ credential: credentialRow({ keyId: 'gone' }) });
    const result = await challenges.completeChallenge(factorBrowser(), totp());
    expect(errorCode(result)).toBe('AUTH_UNAVAILABLE');
    expect(lines.map((l) => l.event)).toContain('auth.totp_key_unreadable');
  });

  it('answers expired when the credential went away under the lock', async () => {
    const { challenges, scripted } = world({ credential: null });
    const result = await challenges.completeChallenge(factorBrowser(), totp());
    expect(errorCode(result)).toBe('AUTH_FACTOR_CHALLENGE_EXPIRED');
    expect(scripted.statements().some(isSessionInsert)).toBe(false);
  });
});

describe('completeChallenge: recovery codes', () => {
  it('works with no key, spends the code once and lifts a TOTP lockout', async () => {
    const { challenges, scripted } = factorSetup(
      factorResponder({ credential: credentialRow({ failed: 100 }) }),
      keylessConfig,
    );
    const result = await challenges.completeChallenge(factorBrowser(keylessConfig), {
      ...recovery(),
      csrf: csrfFor(keylessConfig),
    });
    expect(errorCode(result)).toBe('ok');
    const spend = scripted.statements().find(isRecoverySpend);
    expect(spend?.sql).toContain('"used_at" is null');
    const lift = scripted
      .statements()
      .find((s) => /^update "totp_credentials"/i.test(s.sql) && !isFailureWrite(s));
    expect(lift?.parameters).toContain(0);
  });

  it('answers a code spent in another tab as invalid', async () => {
    const { challenges, scripted } = world({ recoverySpent: false });
    const result = await challenges.completeChallenge(factorBrowser(), recovery());
    expect(errorCode(result)).toBe('AUTH_FACTOR_INVALID');
    expect(scripted.statements().some(isSessionInsert)).toBe(false);
  });

  it('answers a code that matches no row as invalid, with no write but the attempt', async () => {
    const { challenges, scripted } = world();
    const other = RECOVERY[0]?.code.replace(/^./, (c) => (c === '0' ? '1' : '0')) ?? '';
    const result = await challenges.completeChallenge(factorBrowser(), recovery(other));
    expect(errorCode(result)).toBe('AUTH_FACTOR_INVALID');
    expect(scripted.writes().filter((s) => !isAttemptCount(s))).toEqual([]);
  });

  it('refuses more than ten unused rows as a broken read', async () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({
      id: `r${String(i)}`,
      code_hash: RECOVERY[0]?.hash ?? Buffer.alloc(32),
    }));
    const { challenges } = world({ recovery: rows });
    expect(errorCode(await challenges.completeChallenge(factorBrowser(), recovery()))).toBe(
      'AUTH_UNAVAILABLE',
    );
  });
});

describe('completeChallenge: what follows the proof', () => {
  it('sets the session, clears the factor, pre and OAuth cookies, and goes where the sign in was headed', async () => {
    const { challenges } = world();
    const result = await challenges.completeChallenge(factorBrowser(), totp());
    if (!result.ok) throw result.error;
    const names = result.value.setCookies.map((c) => [c.name, c.maxAgeSeconds > 0]);
    expect(names).toContainEqual([factorConfig.cookies.session, true]);
    expect(names).toContainEqual([factorConfig.cookies.factor, false]);
    expect(names).toContainEqual([factorConfig.cookies.pre, false]);
    expect(names).toContainEqual([factorConfig.cookies.oauth, false]);
    expect(result.value.returnTo).toBe('/docs');
    expect(result.value.session.userId).toBe(USER);
    expect(result.value.session.method).toBe('password');
  });

  it('retires the browser’s old session only after the proof', async () => {
    const { challenges, scripted } = world();
    const b = factorBrowser(factorConfig, { [factorConfig.cookies.session]: tokenFor() });
    await challenges.completeChallenge(b, totp());
    const statements = scripted.statements();
    const retire = statements.findIndex(
      (s) => /^delete from "sessions"/i.test(s.sql) && s.parameters.includes(SESSION),
    );
    // The old row is proved by its cookie first; the fake answers no row, so nothing is
    // deleted, but the proof read must come after the new session.
    const oldProof = statements.findIndex(
      (s, i) => i > statements.findIndex(isSessionInsert) && s.parameters.includes(SESSION),
    );
    expect(oldProof).toBeGreaterThan(statements.findIndex(isSessionInsert));
    expect(retire).toBe(-1);
  });

  it('keeps the old session when the factor fails', async () => {
    const { challenges, scripted } = world();
    const b = factorBrowser(factorConfig, { [factorConfig.cookies.session]: tokenFor() });
    await challenges.completeChallenge(b, totp('000000'));
    expect(scripted.statements().some((s) => s.parameters.includes(SESSION))).toBe(false);
  });

  it('carries a stored return path only when it is still safe', async () => {
    const { challenges } = world({ challenge: challengeRow({ returnTo: '//evil.test' }) });
    const result = await challenges.completeChallenge(factorBrowser(), totp());
    if (!result.ok) throw result.error;
    expect(result.value.returnTo).toBe('/');
  });
});

describe('readChallenge', () => {
  it('says live after one read for a proved challenge', async () => {
    const { challenges, scripted } = world();
    expect(await challenges.readChallenge(factorBrowser())).toEqual({
      ok: true,
      value: { kind: 'live' },
    });
    expect(scripted.statements()).toHaveLength(1);
    expect(scripted.writes()).toEqual([]);
  });

  it.each([
    ['a wrong secret', { challenge: challengeRow({ secret: Buffer.alloc(32, 1) }) }],
    ['a missing row', { challenge: null }],
    ['an expired row', { challenge: challengeRow({ live: false }) }],
  ])('says gone for %s, with nothing written', async (_name, shape) => {
    const { challenges, scripted } = world(shape);
    expect(await challenges.readChallenge(factorBrowser())).toEqual({
      ok: true,
      value: { kind: 'gone' },
    });
    expect(scripted.writes()).toEqual([]);
  });

  it('sends nothing for a malformed cookie', async () => {
    const { challenges, scripted } = world();
    const cookies = new Map([[factorConfig.cookies.factor, 'bad']]);
    expect(await challenges.readChallenge({ ...factorBrowser(), cookies })).toEqual({
      ok: true,
      value: { kind: 'gone' },
    });
    expect(scripted.statements()).toEqual([]);
  });

  it('reports a database failure as unavailable', async () => {
    const { challenges } = factorSetup(() => {
      throw new Error('down');
    });
    const result = await challenges.readChallenge(factorBrowser());
    expect(errorCode(result)).toBe('AUTH_UNAVAILABLE');
  });
});

describe('factor cookie', () => {
  it('names a person and carries 32 random bytes', () => {
    expect(factorCookie()).toMatch(/^v1\.[0-9a-z]{26}\.[0-9a-z]{52}$/);
    expect(factorCookie(OTHER_USER)).not.toBe(factorCookie());
    expect(factorCookie(USER, CHALLENGE_SECRET)).toBe(factorCookie());
  });
});

describe('redaction', () => {
  it('never puts a code, secret or cookie in a log line, metric or error', async () => {
    const code = codeAt(STEP);
    const recoveryCode = RECOVERY[0]?.code ?? '';
    const outputs: string[] = [];
    for (const input of [totp(), totp('000000'), recovery(), recovery('0'.repeat(24))]) {
      const { challenges, lines, counted } = world();
      const result = await challenges.completeChallenge(factorBrowser(), input);
      outputs.push(JSON.stringify(lines), JSON.stringify(counted));
      if (!result.ok) outputs.push(result.error.message, JSON.stringify(result.error));
    }
    const text = outputs.join('\n');
    for (const secret of [
      code,
      recoveryCode,
      recoveryCode.replace(/-/g, ''),
      factorCookie(),
      CHALLENGE_SECRET.toString('hex'),
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('logs refusals with a reason from a closed list and the person’s public id', async () => {
    const { challenges, lines } = world();
    await challenges.completeChallenge(factorBrowser(), totp('000000'));
    const refused = lines.find((l) => l.event === 'auth.factor_refused');
    expect(refused?.fields).toMatchObject({ reason: 'invalid', kind: 'totp' });
    expect(String(refused?.fields['userId'])).toMatch(/^usr_/);
  });

  it('counts every outcome under auth.factor with closed labels', async () => {
    const { challenges, counted } = world({ challenge: null });
    await challenges.completeChallenge(factorBrowser(), totp());
    expect(counted).toEqual([
      { name: 'auth.factor', labels: { outcome: 'expired', kind: 'totp' } },
    ]);
  });
});

describe('completeChallenge: failures', () => {
  it('rolls back and answers unavailable when the database fails mid way', async () => {
    const respond = factorResponder();
    const { challenges, scripted } = factorSetup((s) => {
      if (isSessionInsert(s)) throw new Error('connection lost');
      return respond(s);
    });
    const result = await challenges.completeChallenge(factorBrowser(), totp());
    expect(errorCode(result)).toBe('AUTH_UNAVAILABLE');
    expect(scripted.events.at(-1)).toEqual({ kind: 'rollback' });
  });

  it('writes nothing on a refused shape even when the cookie is good', async () => {
    const { challenges, scripted } = world();
    await challenges.completeChallenge(factorBrowser(), totp('1'));
    expect(scripted.statements().filter(isWrite)).toEqual([]);
  });
});
