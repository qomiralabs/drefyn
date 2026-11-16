import type { AuthDatabase, Database } from '@drefyn/db';
import { toPublicId } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import {
  AuthError,
  createSecondFactors,
  type AuthConfig,
  type AuthSecurityNotice,
  type SecondFactorsDeps,
} from '../src/index.ts';
import {
  FACTOR_NOW,
  RECOVERY,
  STEP,
  TOTP_SECRET,
  codeAt,
  credentialRow,
  factorConfig,
  isFactorLock,
  isFailureWrite,
  isRecoverySpend,
  isStepWrite,
  keylessConfig,
  sealedRow,
} from './factor-fixtures.ts';
import { scriptedStore, type Statement } from './scripted-store.ts';
import { base32Encode } from '../src/totp.ts';
import {
  SESSION,
  USER,
  browser,
  capturingLogger,
  noopLimiter,
  sessionInfo,
} from './session-fixtures.ts';

const select = (s: Statement, table: string) =>
  /^select\b/i.test(s.sql) && s.sql.includes(`from "${table}"`);
const isStepUpRead = (s: Statement) => select(s, 'sessions') && s.sql.includes('"fresh"');
const isSessionHold = (s: Statement) => select(s, 'sessions') && /for update$/i.test(s.sql);
const isPendingRead = (s: Statement) => select(s, 'totp_credentials') && /for update$/i.test(s.sql);
const isStatusRead = (s: Statement) =>
  select(s, 'totp_credentials') && !s.sql.includes('"secret_sealed"');
const isCredentialRead = (s: Statement) =>
  select(s, 'totp_credentials') && s.sql.includes('"secret_sealed"') && !isPendingRead(s);
const isUpsert = (s: Statement) => /^insert into "totp_credentials"/i.test(s.sql);
const isConfirmWrite = (s: Statement) =>
  /^update "totp_credentials"/i.test(s.sql) && s.sql.includes('"confirmed_at" = now()');
const isCodesDelete = (s: Statement) => /^delete from "recovery_codes"/i.test(s.sql);
const isCodesInsert = (s: Statement) => /^insert into "recovery_codes"/i.test(s.sql);
const isOthersDelete = (s: Statement) =>
  /^delete from "sessions"/i.test(s.sql) && s.sql.includes('<>');
const isFactorDelete = (s: Statement) => /^delete from "totp_credentials"/i.test(s.sql);
const isChallengeDrop = (s: Statement) => /^delete from "factor_challenges"/i.test(s.sql);
const isDevicesForget = (s: Statement) => /^delete from "known_devices"/i.test(s.sql);
const isStepUpMark = (s: Statement) =>
  /^update "sessions"/i.test(s.sql) && s.sql.includes('"step_up_method"');

interface Shape {
  readonly stepUp?: {
    readonly step_up_method: string | null;
    readonly fresh: boolean;
    readonly password_settled: boolean | null;
  } | null;
  readonly upserted?: boolean;
  readonly pending?: Record<string, unknown> | null;
  readonly credential?: Record<string, unknown> | null;
  readonly held?: boolean;
  readonly failedTo?: number;
  readonly recovery?: readonly { id: string; code_hash: Buffer }[];
  readonly codesLeft?: number;
}

function pendingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sealed = sealedRow();
  return {
    key_id: sealed.keyId,
    secret_nonce: sealed.nonce,
    secret_sealed: sealed.sealed,
    confirmed: false,
    live: true,
    step: STEP,
    now: FACTOR_NOW,
    ...overrides,
  };
}

const KEY = base32Encode(TOTP_SECRET);
const MANUAL_KEY = KEY.match(/.{1,4}/g)?.join(' ') ?? '';

const RECOVERY_ROWS = RECOVERY.map((r, i) => ({ id: `r${String(i)}`, code_hash: r.hash }));

function responder(shape: Shape) {
  const stepUp =
    shape.stepUp === undefined
      ? { step_up_method: 'email', fresh: true, password_settled: null }
      : shape.stepUp;
  return (s: Statement): readonly Record<string, unknown>[] => {
    if (isStepUpRead(s)) return stepUp === null ? [] : [stepUp];
    if (isSessionHold(s)) return shape.held === false ? [] : [{ id: SESSION }];
    if (isUpsert(s)) return shape.upserted === false ? [] : [{ user_id: USER }];
    if (isPendingRead(s)) {
      const pending = shape.pending === undefined ? pendingRow() : shape.pending;
      return pending === null ? [] : [pending];
    }
    if (isCredentialRead(s)) {
      const credential = shape.credential === undefined ? credentialRow() : shape.credential;
      return credential === null ? [] : [credential];
    }
    if (isStatusRead(s)) {
      const credential = shape.credential === undefined ? credentialRow() : shape.credential;
      return credential === null ? [] : [{ confirmed: credential['confirmed'] }];
    }
    if (isFailureWrite(s)) return [{ failed_attempts: shape.failedTo ?? 1 }];
    if (isStepWrite(s)) return [{ user_id: USER }];
    if (select(s, 'recovery_codes') && s.sql.includes('count(')) {
      return [{ left: String(shape.codesLeft ?? 10) }];
    }
    if (select(s, 'recovery_codes')) return (shape.recovery ?? RECOVERY_ROWS).slice();
    if (isRecoverySpend(s)) return [{ id: 'r0' }];
    if (isOthersDelete(s)) return [{ id: 'a' }, { id: 'b' }];
    if (isFactorDelete(s)) return [{ at: FACTOR_NOW }];
    if (isStepUpMark(s)) return [{ authenticated_at: FACTOR_NOW }];
    if (select(s, 'users')) return [{ email: 'person@example.com' }];
    return [];
  };
}

interface Options {
  readonly config?: AuthConfig;
  readonly flag?: boolean | 'throws';
  readonly mailer?: SecondFactorsDeps['mailer'];
}

function setup(shape: Shape = {}, options: Options = {}) {
  const scripted = scriptedStore(responder(shape));
  const { logger, lines } = capturingLogger();
  const limiter = noopLimiter();
  const sent: { to: string; notice: AuthSecurityNotice }[] = [];
  const tasks: (() => Promise<void>)[] = [];
  const flag = options.flag ?? true;
  const factors = createSecondFactors(options.config ?? factorConfig, {
    db: {} as Database,
    authDb: {} as AuthDatabase,
    store: scripted.store,
    limiter,
    logger,
    mailer: options.mailer ?? {
      sendSecurityNotice(to, notice) {
        sent.push({ to, notice });
        return Promise.resolve();
      },
    },
    flag: {
      isOn: () => (flag === 'throws' ? Promise.reject(new Error('down')) : Promise.resolve(flag)),
    },
    random: (n) => (n === 20 ? Buffer.from(TOTP_SECRET) : Buffer.alloc(n, 5)),
    later: (task) => tasks.push(task),
  });
  const drain = async () => {
    for (const task of tasks.splice(0)) await task();
  };
  return { factors, scripted, lines, limiter, sent, drain };
}

const code = (result: { ok: boolean; error?: AuthError }) =>
  result.ok ? 'ok' : result.error?.code;

const totp = (value: string = codeAt(STEP)) => ({ kind: 'totp' as const, code: value });
const recovery = (value: string = RECOVERY[0]?.code ?? '') => ({
  kind: 'recovery_code' as const,
  code: value,
});

describe('status', () => {
  it('reports enrolled and the codes left, and offers enrolment only with a key and the flag', async () => {
    const { factors } = setup({ codesLeft: 7 });
    const result = await factors.status(sessionInfo());
    expect(result).toEqual({
      ok: true,
      value: { available: true, enrolled: true, recoveryCodesLeft: 7 },
    });
  });

  it('a pending row is not enrolled', async () => {
    const { factors } = setup({ credential: credentialRow({ confirmed: false }), codesLeft: 0 });
    const result = await factors.status(sessionInfo());
    expect(result.ok && result.value.enrolled).toBe(false);
  });

  it.each([
    ['the flag off', { flag: false }],
    ['a flag client that throws', { flag: 'throws' as const }],
    ['no key', { config: keylessConfig }],
  ])('is not available with %s, and still says who is enrolled', async (_name, options) => {
    const { factors } = setup({}, options);
    const result = await factors.status(sessionInfo());
    expect(result.ok && result.value).toEqual({
      available: false,
      enrolled: true,
      recoveryCodesLeft: 10,
    });
  });

  it('answers unavailable when the database fails', async () => {
    const { factors, scripted } = setup();
    scripted.respondWith(() => {
      throw new Error('connection reset');
    });
    expect(code(await factors.status(sessionInfo()))).toBe('AUTH_UNAVAILABLE');
  });
});

describe('startEnrollment', () => {
  it('seals a new secret into a pending row and shows it once', async () => {
    const { factors, scripted } = setup({ credential: null });
    const result = await factors.startEnrollment(browser(), sessionInfo());
    if (!result.ok) throw result.error;
    expect(result.value.otpauthUri).toMatch(/^otpauth:\/\/totp\/Drefyn:person%40example\.com\?/);
    expect(result.value.otpauthUri).toContain(`secret=${KEY}`);
    expect(result.value.manualKey).toBe(MANUAL_KEY);
    expect(MANUAL_KEY.replaceAll(' ', '')).toBe(KEY);
    const upsert = scripted.statements().find(isUpsert);
    // Exactly the pending row: never confirmed, never used, no failures.
    expect(upsert?.sql).toMatch(
      /^insert into "totp_credentials" \("user_id", "key_id", "secret_nonce", "secret_sealed", "confirmed_at", "last_used_step", "last_used_at", "failed_attempts"\)/,
    );
    expect(upsert?.sql).toContain('where "totp_credentials"."confirmed_at" is null');
    expect(upsert?.sql).toContain('"updated_at" = now()');
    expect(upsert?.parameters.slice(0, 2)).toEqual([USER, 'k1']);
    expect(upsert?.parameters.slice(4, 8)).toEqual([null, null, null, 0]);
    // Only one transaction, with the step up read before the write.
    const statements = scripted.statements();
    expect(statements.findIndex(isStepUpRead)).toBeLessThan(statements.findIndex(isUpsert));
    expect(JSON.stringify(scripted.events)).not.toContain(TOTP_SECRET.toString('hex'));
  });

  it('never overwrites a confirmed factor', async () => {
    const { factors } = setup({ upserted: false });
    const result = await factors.startEnrollment(browser(), sessionInfo());
    expect(code(result)).toBe('AUTH_FACTOR_ALREADY_ENROLLED');
  });

  it.each([
    ['no step up at all', { step_up_method: null, fresh: true, password_settled: null }],
    [
      'a step up older than 5 minutes',
      { step_up_method: 'email', fresh: false, password_settled: null },
    ],
    [
      'a password step up with a new password',
      { step_up_method: 'password', fresh: true, password_settled: false },
    ],
    [
      'a password step up with no password',
      { step_up_method: 'password', fresh: true, password_settled: null },
    ],
    ['an unknown step up method', { step_up_method: 'sms', fresh: true, password_settled: true }],
  ])('refuses %s, before anything is written', async (_name, stepUp) => {
    const { factors, scripted, lines } = setup({ stepUp });
    const result = await factors.startEnrollment(browser(), sessionInfo());
    expect(code(result)).toBe('AUTH_RECENT_AUTH_REQUIRED');
    expect(scripted.statements().some(isUpsert)).toBe(false);
    expect(lines).toContainEqual({
      event: 'auth.factor_action_refused',
      fields: {
        action: 'start_enrollment',
        outcome: 'AUTH_RECENT_AUTH_REQUIRED',
        userId: toPublicId('usr', USER),
        sessionId: toPublicId('ses', SESSION),
      },
    });
  });

  it.each([
    ['email', null],
    ['google', null],
    ['github_session', false],
    ['password', true],
  ])('takes a fresh %s step up', async (method, settled) => {
    const { factors } = setup({
      stepUp: { step_up_method: method, fresh: true, password_settled: settled },
    });
    expect(code(await factors.startEnrollment(browser(), sessionInfo()))).toBe('ok');
  });

  it('refuses a session that is gone', async () => {
    const { factors } = setup({ stepUp: null });
    const result = await factors.startEnrollment(browser(), sessionInfo());
    expect(code(result)).toBe('AUTH_SESSION_INVALID');
  });

  it('is hidden with the flag off, and statement free', async () => {
    const { factors, scripted } = setup({}, { flag: false });
    expect(code(await factors.startEnrollment(browser(), sessionInfo()))).toBe('AUTH_NOT_FOUND');
    expect(scripted.statements()).toEqual([]);
  });

  it('is unavailable with no key', async () => {
    const { factors, scripted } = setup({}, { config: keylessConfig });
    expect(code(await factors.startEnrollment(browser(), sessionInfo()))).toBe('AUTH_UNAVAILABLE');
    expect(scripted.statements()).toEqual([]);
  });
});

describe('confirmEnrollment', () => {
  it('confirms with the current code, spends it and starts the failures at zero', async () => {
    const { factors, scripted, limiter } = setup();
    const result = await factors.confirmEnrollment(browser(), sessionInfo(), {
      code: codeAt(STEP),
    });
    if (!result.ok) throw result.error;
    if (result.value.kind !== 'enrolled') throw new Error('expected enrolled');
    expect(result.value.recoveryCodes).toHaveLength(10);
    expect(new Set(result.value.recoveryCodes).size).toBe(10);
    expect(limiter.calls.map(([bucket]) => bucket)).toEqual(['totp_verify']);
    const write = scripted.statements().find(isConfirmWrite);
    expect(write?.sql).toContain('"last_used_step" = $1');
    expect(write?.sql).toContain('"failed_attempts" = $2');
    expect(write?.parameters.slice(0, 2)).toEqual([STEP, 0]);
    expect(write?.sql).toContain('"confirmed_at" is null');
  });

  it('takes the factor lock exclusive and ends the other sessions, devices and challenge', async () => {
    const { factors, scripted, sent } = setup();
    const result = await factors.confirmEnrollment(browser(), sessionInfo(), {
      code: codeAt(STEP - 1),
    });
    if (!result.ok || result.value.kind !== 'enrolled') throw new Error('expected enrolled');
    const statements = scripted.statements();
    const lock = statements.find(isFactorLock);
    expect(lock?.sql).toContain('pg_advisory_xact_lock(');
    expect(lock?.sql).not.toContain('shared');
    const order = [
      isFactorLock,
      isPendingRead,
      isConfirmWrite,
      isCodesDelete,
      isCodesInsert,
      isOthersDelete,
      isChallengeDrop,
      isDevicesForget,
    ].map((match) => statements.findIndex(match));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(statements.find(isOthersDelete)?.parameters).toContain(SESSION);
    expect(result.value.setCookies.map((c) => c.name)).toEqual([factorConfig.cookies.device]);
    expect(sent).toEqual([]);
    await result.value.send();
    expect(sent).toEqual([
      { to: 'person@example.com', notice: { kind: 'second_factor_added', at: FACTOR_NOW } },
    ]);
  });

  it('a wrong code shows the same secret again, counts the failure and mails nobody', async () => {
    const { factors, scripted, sent, drain } = setup({ failedTo: 3 });
    const result = await factors.confirmEnrollment(browser(), sessionInfo(), {
      code: codeAt(STEP + 1),
    });
    if (!result.ok || result.value.kind !== 'mistyped') throw new Error('expected mistyped');
    expect(result.value.enrollment.manualKey).toBe(MANUAL_KEY);
    const failure = scripted.statements().find(isFailureWrite);
    // The expiry runs from the seal, so a failure never stretches it.
    expect(failure?.sql).not.toContain('updated_at');
    expect(scripted.statements().some(isConfirmWrite)).toBe(false);
    expect(scripted.statements().some(isCodesInsert)).toBe(false);
    await drain();
    expect(sent).toEqual([]);
  });

  it.each([
    ['no pending row', { pending: null }, 'AUTH_FACTOR_CHALLENGE_EXPIRED'],
    [
      'a pending row older than 15 minutes',
      { pending: pendingRow({ live: false }) },
      'AUTH_FACTOR_CHALLENGE_EXPIRED',
    ],
    [
      'a confirmed row',
      { pending: pendingRow({ confirmed: true }) },
      'AUTH_FACTOR_ALREADY_ENROLLED',
    ],
    [
      'a row sealed under another key',
      { pending: pendingRow({ key_id: 'k9' }) },
      'AUTH_UNAVAILABLE',
    ],
  ])('refuses %s and shows no codes', async (_name, shape, expected) => {
    const { factors, scripted } = setup(shape);
    const result = await factors.confirmEnrollment(browser(), sessionInfo(), {
      code: codeAt(STEP),
    });
    expect(code(result)).toBe(expected);
    expect(scripted.statements().some(isCodesInsert)).toBe(false);
    expect(scripted.events.at(-1)).toEqual({ kind: 'rollback' });
  });

  it('refuses a stale step up before anything is counted', async () => {
    const { factors, limiter, scripted } = setup({
      stepUp: { step_up_method: 'email', fresh: false, password_settled: null },
    });
    const result = await factors.confirmEnrollment(browser(), sessionInfo(), {
      code: codeAt(STEP),
    });
    expect(code(result)).toBe('AUTH_RECENT_AUTH_REQUIRED');
    expect(limiter.calls).toEqual([]);
    expect(scripted.statements().some(isPendingRead)).toBe(false);
  });

  it('refuses a step up that went stale between the first read and the lock', async () => {
    const { factors, scripted } = setup();
    let reads = 0;
    const base = responder({});
    scripted.respondWith((s) => {
      if (isStepUpRead(s)) {
        reads += 1;
        return [{ step_up_method: 'email', fresh: reads === 1, password_settled: null }];
      }
      return base(s);
    });
    const result = await factors.confirmEnrollment(browser(), sessionInfo(), {
      code: codeAt(STEP),
    });
    expect(code(result)).toBe('AUTH_RECENT_AUTH_REQUIRED');
    expect(scripted.statements().some(isPendingRead)).toBe(false);
  });

  it.each(['12345', '1234567', 'abcdef', ''])('refuses the shape %j for free', async (typed) => {
    const { factors, scripted, limiter } = setup();
    const result = await factors.confirmEnrollment(browser(), sessionInfo(), { code: typed });
    expect(code(result)).toBe('AUTH_FACTOR_INVALID');
    expect(scripted.statements()).toEqual([]);
    expect(limiter.calls).toEqual([]);
  });

  it('is hidden with the flag off and unavailable with no key', async () => {
    const off = setup({}, { flag: false });
    expect(
      code(await off.factors.confirmEnrollment(browser(), sessionInfo(), { code: '123456' })),
    ).toBe('AUTH_NOT_FOUND');
    const keyless = setup({}, { config: keylessConfig });
    expect(
      code(await keyless.factors.confirmEnrollment(browser(), sessionInfo(), { code: '123456' })),
    ).toBe('AUTH_UNAVAILABLE');
  });

  it('a notice that cannot be sent never undoes the enrolment', async () => {
    const { factors, lines } = setup(
      {},
      { mailer: { sendSecurityNotice: () => Promise.reject(new Error('smtp down')) } },
    );
    const result = await factors.confirmEnrollment(browser(), sessionInfo(), {
      code: codeAt(STEP),
    });
    if (!result.ok || result.value.kind !== 'enrolled') throw new Error('expected enrolled');
    await expect(result.value.send()).resolves.toBeUndefined();
    expect(lines).toContainEqual({
      event: 'auth.factor_notice_failed',
      fields: { kind: 'second_factor_added', userId: toPublicId('usr', USER) },
    });
  });
});

describe('removeFactor', () => {
  it('needs a code in the request, then deletes the factor, the codes and the other sessions', async () => {
    const { factors, scripted, sent } = setup();
    const result = await factors.removeFactor(browser(), sessionInfo(), totp());
    if (!result.ok) throw result.error;
    const statements = scripted.statements();
    const order = [
      isFactorLock,
      isSessionHold,
      isCredentialRead,
      isStepWrite,
      isFactorDelete,
      isCodesDelete,
      isOthersDelete,
      isChallengeDrop,
      isDevicesForget,
    ].map((match) => statements.findIndex(match));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(statements.find(isFactorLock)?.sql).not.toContain('shared');
    await result.value.send();
    expect(sent).toEqual([
      { to: 'person@example.com', notice: { kind: 'second_factor_removed', at: FACTOR_NOW } },
    ]);
  });

  it('takes a recovery code too', async () => {
    const { factors, scripted } = setup();
    const result = await factors.removeFactor(browser(), sessionInfo(), recovery());
    expect(code(result)).toBe('ok');
    expect(scripted.statements().some(isRecoverySpend)).toBe(true);
    expect(scripted.statements().some(isFactorDelete)).toBe(true);
  });

  it('a wrong code removes nothing, keeps the failure and warns at the third', async () => {
    const { factors, scripted, sent, drain, limiter } = setup({ failedTo: 3 });
    const result = await factors.removeFactor(browser(), sessionInfo(), totp(codeAt(STEP + 1)));
    expect(code(result)).toBe('AUTH_FACTOR_INVALID');
    expect(scripted.statements().some(isFactorDelete)).toBe(false);
    expect(scripted.events.at(-1)).toEqual({ kind: 'commit' });
    expect(sent).toEqual([]);
    await drain();
    expect(limiter.calls.map(([bucket]) => bucket)).toEqual([
      'totp_verify',
      'second_factor_notice',
    ]);
    expect(sent).toEqual([
      { to: 'person@example.com', notice: { kind: 'second_factor_failures', at: FACTOR_NOW } },
    ]);
  });

  it('answers not enrolled when there is nothing to remove', async () => {
    const { factors } = setup({ credential: credentialRow({ confirmed: false }) });
    const result = await factors.removeFactor(browser(), sessionInfo(), totp());
    expect(code(result)).toBe('AUTH_FACTOR_NOT_ENROLLED');
  });

  it('refuses a session that is gone, removing nothing', async () => {
    const { factors, scripted } = setup({ held: false });
    const result = await factors.removeFactor(browser(), sessionInfo(), totp());
    expect(code(result)).toBe('AUTH_SESSION_INVALID');
    expect(scripted.statements().some(isFactorDelete)).toBe(false);
  });

  it('refuses a bad shape before the budget', async () => {
    const { factors, limiter, scripted } = setup();
    const result = await factors.removeFactor(browser(), sessionInfo(), totp('12'));
    expect(code(result)).toBe('AUTH_FACTOR_INVALID');
    expect(limiter.calls).toEqual([]);
    expect(scripted.statements()).toEqual([]);
  });

  it('still works with the flag off, so an enrolled person keeps control', async () => {
    const { factors } = setup({}, { flag: false });
    expect(code(await factors.removeFactor(browser(), sessionInfo(), totp()))).toBe('ok');
  });

  it('passes on a limiter refusal and counts nothing more', async () => {
    const { scripted } = setup();
    const limited = createSecondFactors(factorConfig, {
      store: scripted.store,
      limiter: {
        keyFor: () => Buffer.alloc(32),
        reserve: () => Promise.reject(new AuthError('AUTH_RATE_LIMITED')),
      },
      logger: { warn: () => undefined },
      mailer: {},
      flag: { isOn: () => Promise.resolve(true) },
    });
    const result = await limited.removeFactor(browser(), sessionInfo(), totp());
    expect(code(result)).toBe('AUTH_RATE_LIMITED');
    expect(scripted.statements()).toEqual([]);
  });
});

describe('replaceRecoveryCodes', () => {
  it('needs a code, then swaps every code in one transaction and drops the challenge', async () => {
    const { factors, scripted, sent } = setup();
    const result = await factors.replaceRecoveryCodes(browser(), sessionInfo(), recovery());
    if (!result.ok) throw result.error;
    expect(result.value.recoveryCodes).toHaveLength(10);
    expect(result.value.setCookies).toEqual([]);
    const statements = scripted.statements();
    const order = [isRecoverySpend, isCodesDelete, isCodesInsert, isChallengeDrop].map((m) =>
      statements.findIndex(m),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(statements.some(isOthersDelete)).toBe(false);
    await result.value.send();
    expect(sent).toEqual([
      { to: 'person@example.com', notice: { kind: 'recovery_codes_replaced', at: FACTOR_NOW } },
    ]);
  });

  it('a wrong recovery code changes nothing and warns within the cap', async () => {
    const { factors, scripted, sent, drain } = setup();
    const result = await factors.replaceRecoveryCodes(
      browser(),
      sessionInfo(),
      recovery('aaaaaa-aaaaaa-aaaaaa-aaaaaa'),
    );
    expect(code(result)).toBe('AUTH_FACTOR_INVALID');
    expect(scripted.statements().some(isCodesInsert)).toBe(false);
    await drain();
    expect(sent.map((m) => m.notice.kind)).toEqual(['second_factor_failures']);
  });
});

describe('stepUpWithFactor', () => {
  it('marks the session as stepped up with TOTP', async () => {
    const { factors, scripted, lines, sent, drain } = setup();
    const result = await factors.stepUpWithFactor(browser(), sessionInfo(), totp());
    if (!result.ok) throw result.error;
    expect(result.value.stepUpMethod).toBe('totp');
    expect(result.value.authenticatedAt).toEqual(FACTOR_NOW);
    const mark = scripted.statements().find(isStepUpMark);
    expect(mark?.parameters).toContain('totp');
    expect(scripted.statements().find(isFactorLock)?.sql).toContain('shared');
    expect(lines.map((l) => l.event)).toContain('auth.step_up_passed');
    await drain();
    expect(sent).toEqual([]);
  });

  it('a recovery code steps up and tells the person how many are left', async () => {
    const { factors, sent, drain } = setup();
    const result = await factors.stepUpWithFactor(browser(), sessionInfo(), recovery());
    expect(result.ok && result.value.stepUpMethod).toBe('recovery_code');
    await drain();
    expect(sent).toEqual([
      {
        to: 'person@example.com',
        notice: { kind: 'recovery_code_used', codesLeft: 9, at: FACTOR_NOW },
      },
    ]);
  });

  it('a wrong code fails, is logged with ids only, and warns at the ceiling', async () => {
    const { factors, lines, sent, drain, limiter } = setup({ failedTo: 100 });
    const result = await factors.stepUpWithFactor(browser(), sessionInfo(), totp('000000'));
    expect(code(result)).toBe('AUTH_FACTOR_INVALID');
    expect(lines).toContainEqual({
      event: 'auth.step_up_failed',
      fields: {
        method: 'totp',
        outcome: 'AUTH_FACTOR_INVALID',
        userId: toPublicId('usr', USER),
        sessionId: toPublicId('ses', SESSION),
      },
    });
    await drain();
    // Reaching the ceiling is always sent: it is not under the failure cap.
    expect(limiter.calls.map(([bucket]) => bucket)).toEqual(['totp_verify']);
    expect(sent.map((m) => m.notice.kind)).toEqual(['second_factor_disabled']);
  });

  it('answers disabled once TOTP is at the ceiling', async () => {
    const { factors } = setup({ credential: credentialRow({ failed: 100 }) });
    const result = await factors.stepUpWithFactor(browser(), sessionInfo(), totp());
    expect(code(result)).toBe('AUTH_FACTOR_DISABLED');
  });

  it('answers not enrolled without a factor, and unavailable when the database fails', async () => {
    const { factors, scripted } = setup({ credential: null });
    const missing = await factors.stepUpWithFactor(browser(), sessionInfo(), totp());
    expect(code(missing)).toBe('AUTH_FACTOR_NOT_ENROLLED');
    scripted.respondWith(() => {
      throw new Error('connection reset');
    });
    const down = await factors.stepUpWithFactor(browser(), sessionInfo(), totp());
    expect(code(down)).toBe('AUTH_UNAVAILABLE');
  });

  it('answers session invalid when the session ended meanwhile', async () => {
    const { factors, scripted } = setup();
    const base = responder({});
    scripted.respondWith((s) => (isStepUpMark(s) ? [] : base(s)));
    const result = await factors.stepUpWithFactor(browser(), sessionInfo(), totp());
    expect(code(result)).toBe('AUTH_SESSION_INVALID');
  });
});

describe('construction', () => {
  it('needs a database or a store and a limiter', () => {
    expect(() =>
      createSecondFactors(factorConfig, {
        logger: { warn: () => undefined },
        mailer: {},
        flag: { isOn: () => Promise.resolve(true) },
      }),
    ).toThrow(TypeError);
  });

  it('builds its own store and limiter from the databases', () => {
    expect(() =>
      createSecondFactors(factorConfig, {
        db: {} as Database,
        authDb: {} as AuthDatabase,
        logger: { warn: () => undefined },
        mailer: {},
        flag: { isOn: () => Promise.resolve(true) },
      }),
    ).not.toThrow();
  });
});
