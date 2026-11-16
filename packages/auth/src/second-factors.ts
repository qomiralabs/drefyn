import type { Result } from '@drefyn/address';
import { withAuth, withUser, type AuthDatabase, type Database, type UserSchema } from '@drefyn/db';
import type { UserId } from '@drefyn/tenancy';
import { randomBytes } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import type { AuthConfig } from './config.ts';
import type { BrowserContext, CookieSpec } from './cookies.ts';
import { resetDevices } from './devices.ts';
import type { AuthNoticeMailer } from './email-change.ts';
import {
  ENROLMENT_STEP_UP_MINUTES,
  PENDING_ENROLMENT_MINUTES,
  SETTLED_PASSWORD_HOURS,
  enrolmentStepUpPasses,
} from './enrolment-step-up.ts';
import { AuthError, type AuthErrorCode } from './errors.ts';
import {
  sendFactorAlert,
  sendFactorNotice,
  startNow,
  type FactorNoticeDeps,
  type Later,
} from './factor-notices.ts';
import { spendFactorProof } from './factor-proof.ts';
import { dropChallenge, lockFactor } from './factor-rows.ts';
import {
  FACTOR_FAILURE_CEILING,
  factorError,
  factorInput,
  reportFactor,
  reserveFactor,
  verifyFactor,
  type FactorCheck,
  type FactorCode,
  type FactorOutcome,
} from './factor-verify.ts';
import {
  createRateLimiter,
  type AuthLogger,
  type AuthMetrics,
  type RateLimiter,
} from './rate-limiter.ts';
import { newRecoveryCodes } from './recovery-codes.ts';
import {
  fail,
  idFields,
  ok,
  quietInfo,
  unavailable,
  type SessionInfo,
  type SessionStore,
} from './session-support.ts';
import { logStepUpFailed, markStepUp } from './step-up.ts';
import {
  TOTP_SECRET_BYTES,
  base32Encode,
  isTotpShape,
  matchTotp,
  otpauthUri,
  type FactorKind,
} from './totp.ts';
import { pendingTotpRow } from './totp-rows.ts';

// The part of the flag client this needs. The flag gates enrolment alone: turning it off
// never drops the factor for anyone who has one.
export interface TotpFlag {
  isOn(name: 'auth.totp', ctx: { readonly userId: UserId }): Promise<boolean>;
}

export interface FactorStatus {
  // A key is configured and the flag is on, so enrolment may be offered.
  readonly available: boolean;
  readonly enrolled: boolean;
  readonly recoveryCodesLeft: number;
}

// Shown once, from a POST, and never logged, stored elsewhere or put in a link.
export interface TotpEnrollment {
  readonly otpauthUri: string;
  // RFC 4648 base32 in groups of four, for typing into an app by hand.
  readonly manualKey: string;
}

export interface EnrolledFactor {
  // Shown once.
  readonly recoveryCodes: readonly string[];
  readonly setCookies: readonly CookieSpec[];
  // Mails the notice and never throws; run it after the response.
  readonly send: () => Promise<void>;
}

// A wrong code on a pending row shows the same secret again, so the person can retry
// without starting over. Only this answer carries it: a refusal of any other kind shows
// nothing.
export type ConfirmedEnrollment =
  | ({ readonly kind: 'enrolled' } & EnrolledFactor)
  | { readonly kind: 'mistyped'; readonly enrollment: TotpEnrollment };

export interface SecondFactors {
  status(s: SessionInfo): Promise<Result<FactorStatus, AuthError>>;
  // Needs a step up within 5 minutes; a password one counts only once the password is a
  // day old. Never overwrites a confirmed factor.
  startEnrollment(b: BrowserContext, s: SessionInfo): Promise<Result<TotpEnrollment, AuthError>>;
  // The same step up rule again. Ends every other session of the person.
  confirmEnrollment(
    b: BrowserContext,
    s: SessionInfo,
    input: { readonly code: string },
  ): Promise<Result<ConfirmedEnrollment, AuthError>>;
  // A code in the same request, either kind. Ends every other session of the person.
  removeFactor(
    b: BrowserContext,
    s: SessionInfo,
    input: FactorCode,
  ): Promise<Result<{ readonly send: () => Promise<void> }, AuthError>>;
  // A code in the same request, either kind. The old codes stop working as the new ones
  // are written.
  replaceRecoveryCodes(
    b: BrowserContext,
    s: SessionInfo,
    input: FactorCode,
  ): Promise<Result<EnrolledFactor, AuthError>>;
  // Once enrolled, the only step up there is.
  stepUpWithFactor(
    b: BrowserContext,
    s: SessionInfo,
    input: FactorCode,
  ): Promise<Result<SessionInfo, AuthError>>;
}

export interface SecondFactorsDeps {
  readonly db?: Database;
  readonly authDb?: AuthDatabase;
  readonly store?: SessionStore;
  readonly limiter?: RateLimiter;
  readonly logger: AuthLogger;
  readonly metrics?: AuthMetrics;
  readonly mailer: Partial<AuthNoticeMailer>;
  readonly flag: TotpFlag;
  readonly random?: (bytes: number) => Uint8Array;
  // Where a failed attempt's notice runs, so the refusal does not wait on mail.
  readonly later?: Later;
}

// Thrown inside a transaction to roll it back with a closed code.
class Refused extends Error {
  readonly code: AuthErrorCode;
  constructor(code: AuthErrorCode) {
    super(code);
    this.code = code;
  }
}

const MANUAL_GROUP = 4;

export function createSecondFactors(config: AuthConfig, deps: SecondFactorsDeps): SecondFactors {
  const { db, authDb } = deps;
  const store: SessionStore =
    deps.store ??
    (db !== undefined && authDb !== undefined
      ? {
          user: (userId, work) => withUser(db, { userId }, work),
          auth: (work) => withAuth(authDb, work),
        }
      : missing());
  const limiter =
    deps.limiter ??
    (authDb === undefined
      ? missing()
      : createRateLimiter({
          db: authDb,
          keys: config.keys,
          limits: config.rateLimits,
          logger: deps.logger,
          ...(deps.metrics === undefined ? {} : { metrics: deps.metrics }),
        }));
  const random = deps.random ?? ((n: number) => randomBytes(n));
  const later = deps.later ?? startNow;
  const notices: FactorNoticeDeps = { store, limiter, logger: deps.logger, mailer: deps.mailer };
  const ids = (s: SessionInfo) =>
    idFields({ userId: ['usr', s.userId], sessionId: ['ses', s.sessionId] });
  const report = (kind: FactorKind, outcome: FactorOutcome, userId: UserId) => {
    reportFactor({ logger: deps.logger, metrics: deps.metrics }, kind, outcome, userId);
  };

  // The flag client answers its safe value on a provider failure; a throw reads as off too.
  async function enrolmentOn(userId: UserId): Promise<boolean> {
    try {
      // Typed as boolean, but only a real true turns enrolment on.
      const value: unknown = await deps.flag.isOn('auth.totp', { userId });
      return value === true;
    } catch {
      return false;
    }
  }

  // Ids and a closed code only: never a code, a secret or an address.
  function refused<T>(s: SessionInfo, action: string, error: unknown): Result<T, AuthError> {
    const result = fail<T>(error instanceof Refused ? new AuthError(error.code) : error);
    if (!result.ok) {
      quietInfo(deps.logger, 'auth.factor_action_refused', {
        action,
        outcome: result.error.code,
        ...ids(s),
      });
    }
    return result;
  }

  function enrollment(s: SessionInfo, secret: Uint8Array): TotpEnrollment {
    const key = base32Encode(secret);
    const groups: string[] = [];
    for (let i = 0; i < key.length; i += MANUAL_GROUP) groups.push(key.slice(i, i + MANUAL_GROUP));
    return Object.freeze({
      otpauthUri: otpauthUri({ issuer: config.totp.issuer, account: s.email, secret }),
      manualKey: groups.join(' '),
    });
  }

  // The session as it is now, with how it last proved itself and how old the password is.
  // A refusal names what is missing: a dead session, or no fresh step up.
  async function requireEnrolmentStepUp(tx: Transaction<UserSchema>, s: SessionInfo) {
    const row = await tx
      .selectFrom('sessions')
      .select((eb) => [
        'step_up_method',
        sql<boolean>`authenticated_at > now() - make_interval(mins => ${ENROLMENT_STEP_UP_MINUTES})`.as(
          'fresh',
        ),
        eb
          .selectFrom('password_credentials')
          .select(
            sql<boolean>`updated_at <= now() - make_interval(hours => ${SETTLED_PASSWORD_HOURS})`.as(
              'settled',
            ),
          )
          .where('user_id', '=', sql<string>`app.current_user_id()`)
          .as('password_settled'),
      ])
      .where('id', '=', s.sessionId)
      .where('user_id', '=', sql<string>`app.current_user_id()`)
      .where('expires_at', '>', sql<Date>`now()`)
      .executeTakeFirst();
    if (row === undefined) throw new Refused('AUTH_SESSION_INVALID');
    const passes = enrolmentStepUpPasses({
      method: row.step_up_method,
      fresh: row.fresh,
      passwordSettled: row.password_settled,
    });
    if (!passes) throw new Refused('AUTH_RECENT_AUTH_REQUIRED');
  }

  // The session must still be live, and is held so a sign out elsewhere waits for this.
  async function holdSession(tx: Transaction<UserSchema>, s: SessionInfo) {
    const live = await tx
      .selectFrom('sessions')
      .select('id')
      .where('id', '=', s.sessionId)
      .where('user_id', '=', sql<string>`app.current_user_id()`)
      .where('expires_at', '>', sql<Date>`now()`)
      .forUpdate()
      .executeTakeFirst();
    if (live === undefined) throw new Refused('AUTH_SESSION_INVALID');
  }

  // Every other session and every known device go, as on a password change: whoever held
  // them did not pass this check. The challenge goes too, whatever it was waiting for.
  async function endOthers(tx: Transaction<UserSchema>, s: SessionInfo, b: BrowserContext) {
    const gone = await tx
      .deleteFrom('sessions')
      .where('user_id', '=', sql<string>`app.current_user_id()`)
      .where('id', '<>', s.sessionId)
      .returning('id')
      .execute();
    await dropChallenge(tx);
    const cookies = await resetDevices(tx, config, s.userId, b.userAgent, random);
    return { revoked: gone.length, cookies };
  }

  async function writeRecoveryCodes(tx: Transaction<UserSchema>, userId: UserId) {
    await tx
      .deleteFrom('recovery_codes')
      .where('user_id', '=', sql<string>`app.current_user_id()`)
      .execute();
    const codes = newRecoveryCodes(userId);
    await tx
      .insertInto('recovery_codes')
      .values(codes.map((c) => ({ user_id: userId, code_hash: c.hash })))
      .execute();
    return codes.map((c) => c.code);
  }

  // The shared opening of every action that takes a code from a signed in person: the
  // shape for free, then the budget, then the check under the exclusive lock. work runs
  // only on a pass, in the same transaction, so the code and the change succeed together.
  async function withFactor<T>(
    b: BrowserContext,
    s: SessionInfo,
    input: FactorCode,
    mode: 'shared' | 'exclusive',
    work: (tx: Transaction<UserSchema>, check: Extract<FactorCheck, { ok: true }>) => Promise<T>,
  ): Promise<
    { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: AuthError }
  > {
    const code = factorInput(input);
    if (code === null) {
      report(input.kind === 'recovery_code' ? 'recovery_code' : 'totp', 'invalid', s.userId);
      throw new Refused('AUTH_FACTOR_INVALID');
    }
    try {
      await reserveFactor(limiter, code.kind, { userId: s.userId, ip: b.ip });
    } catch (error) {
      const limited = error instanceof AuthError && error.code === 'AUTH_RATE_LIMITED';
      report(code.kind, limited ? 'rate_limited' : 'unavailable', s.userId);
      throw error;
    }
    const outcome = await store.user(s.userId, async (tx) => {
      await lockFactor(tx, s.userId, mode);
      await holdSession(tx, s);
      const check = await verifyFactor(tx, { config, logger: deps.logger }, s.userId, code);
      if (!check.ok) return check;
      // Spent here, so the proof cannot outlive the action it was made for.
      if (!spendFactorProof(check.proof, s.userId)) throw new Refused('AUTH_UNAVAILABLE');
      return { ok: true as const, value: await work(tx, check), check };
    });
    if (!outcome.ok) {
      if (outcome.reason === 'not_enrolled') throw new Refused('AUTH_FACTOR_NOT_ENROLLED');
      report(code.kind, outcome.reason, s.userId);
      const alert = outcome.alert;
      if (alert !== null) later(() => sendFactorAlert(notices, s.userId, alert));
      return { ok: false, error: factorError(outcome.reason) };
    }
    report(code.kind, outcome.check.previousStep ? 'matched_previous_step' : 'passed', s.userId);
    return { ok: true, value: outcome.value };
  }

  return Object.freeze({
    async status(s) {
      try {
        const row = await store.user(s.userId, async (tx) => {
          const credential = await tx
            .selectFrom('totp_credentials')
            .select(sql<boolean>`confirmed_at is not null`.as('confirmed'))
            .where('user_id', '=', sql<string>`app.current_user_id()`)
            .executeTakeFirst();
          const codes = await tx
            .selectFrom('recovery_codes')
            .select((eb) => eb.fn.countAll<string>().as('left'))
            .where('user_id', '=', sql<string>`app.current_user_id()`)
            .where('used_at', 'is', null)
            .executeTakeFirstOrThrow();
          return { enrolled: credential?.confirmed === true, left: Number(codes.left) };
        });
        const available = config.totp.available && (await enrolmentOn(s.userId));
        return ok({ available, enrolled: row.enrolled, recoveryCodesLeft: row.left });
      } catch (error) {
        return fail(error);
      }
    },

    async startEnrollment(b, s) {
      try {
        if (!(await enrolmentOn(s.userId))) throw new Refused('AUTH_NOT_FOUND');
        const sealer = config.totp.sealer;
        if (sealer === null) throw new Refused('AUTH_UNAVAILABLE');
        const secret = Buffer.from(random(TOTP_SECRET_BYTES));
        try {
          const sealed = sealer.seal(secret, { userId: s.userId });
          await store.user(s.userId, async (tx) => {
            await requireEnrolmentStepUp(tx, s);
            // A pending row is replaced, with a fresh 15 minutes; a confirmed one never is.
            const row = pendingTotpRow(s.userId, sealed);
            const written = await tx
              .insertInto('totp_credentials')
              .values(row)
              .onConflict((c) =>
                c
                  .column('user_id')
                  .doUpdateSet({
                    key_id: row.key_id,
                    secret_nonce: row.secret_nonce,
                    secret_sealed: row.secret_sealed,
                    last_used_step: null,
                    last_used_at: null,
                    failed_attempts: 0,
                    updated_at: sql<Date>`now()`,
                  })
                  .where('totp_credentials.confirmed_at', 'is', null),
              )
              .returning('user_id')
              .executeTakeFirst();
            if (written === undefined) throw new Refused('AUTH_FACTOR_ALREADY_ENROLLED');
          });
          return ok(enrollment(s, secret));
        } finally {
          secret.fill(0);
        }
      } catch (error) {
        return refused(s, 'start_enrollment', error);
      }
    },

    async confirmEnrollment(b, s, input) {
      try {
        if (!(await enrolmentOn(s.userId))) throw new Refused('AUTH_NOT_FOUND');
        const sealer = config.totp.sealer;
        if (sealer === null) throw new Refused('AUTH_UNAVAILABLE');
        if (!isTotpShape(input.code)) {
          report('totp', 'invalid', s.userId);
          throw new Refused('AUTH_FACTOR_INVALID');
        }
        // One read before the budget, so a session with no step up spends nothing.
        await store.user(s.userId, (tx) => requireEnrolmentStepUp(tx, s));
        await reserveFactor(limiter, 'totp', { userId: s.userId, ip: b.ip });
        const outcome = await store.user(s.userId, async (tx) => {
          // Exclusive: a sign in that read "no factor" has finished, and one that has not
          // started will see the row.
          await lockFactor(tx, s.userId, 'exclusive');
          await requireEnrolmentStepUp(tx, s);
          const pending = await tx
            .selectFrom('totp_credentials')
            .select([
              'key_id',
              'secret_nonce',
              'secret_sealed',
              sql<boolean>`confirmed_at is not null`.as('confirmed'),
              sql<boolean>`updated_at > now() - make_interval(mins => ${PENDING_ENROLMENT_MINUTES})`.as(
                'live',
              ),
              sql<number>`floor(extract(epoch from now()) / 30)::int`.as('step'),
              sql<Date>`now()`.as('now'),
            ])
            .where('user_id', '=', sql<string>`app.current_user_id()`)
            .forUpdate()
            .executeTakeFirst();
          if (pending === undefined) throw new Refused('AUTH_FACTOR_CHALLENGE_EXPIRED');
          if (pending.confirmed) throw new Refused('AUTH_FACTOR_ALREADY_ENROLLED');
          if (!pending.live) throw new Refused('AUTH_FACTOR_CHALLENGE_EXPIRED');
          let secret: Buffer;
          try {
            secret = sealer.open(
              { keyId: pending.key_id, nonce: pending.secret_nonce, sealed: pending.secret_sealed },
              { userId: s.userId },
            );
          } catch {
            throw new Refused('AUTH_UNAVAILABLE');
          }
          try {
            const matched = matchTotp(secret, input.code, pending.step);
            if (matched === null) {
              // Kept, as any failure is; never mailed, since nothing is enrolled yet.
              await tx
                .updateTable('totp_credentials')
                .set({
                  failed_attempts: sql<number>`least("failed_attempts" + 1, ${sql.lit(FACTOR_FAILURE_CEILING)})`,
                })
                .where('user_id', '=', sql<string>`app.current_user_id()`)
                .execute();
              return { kind: 'mistyped' as const, enrollment: enrollment(s, secret) };
            }
            // The confirming code is spent here, so it cannot sign in once more, and the
            // failures from typing it start the person at zero.
            await tx
              .updateTable('totp_credentials')
              .set({
                confirmed_at: sql<Date>`now()`,
                last_used_step: matched,
                failed_attempts: 0,
                last_used_at: sql<Date>`now()`,
                updated_at: sql<Date>`now()`,
              })
              .where('user_id', '=', sql<string>`app.current_user_id()`)
              .where('confirmed_at', 'is', null)
              .execute();
          } finally {
            secret.fill(0);
          }
          const recoveryCodes = await writeRecoveryCodes(tx, s.userId);
          const ended = await endOthers(tx, s, b);
          return { kind: 'enrolled' as const, recoveryCodes, ...ended, at: pending.now };
        });
        if (outcome.kind === 'mistyped') {
          report('totp', 'invalid', s.userId);
          return ok(outcome);
        }
        report('totp', 'passed', s.userId);
        quietInfo(deps.logger, 'auth.totp_enrolled', { revoked: outcome.revoked, ...ids(s) });
        return ok({
          kind: 'enrolled',
          recoveryCodes: outcome.recoveryCodes,
          setCookies: outcome.cookies,
          send: () =>
            sendFactorNotice(
              notices,
              s.userId,
              { kind: 'second_factor_added', at: outcome.at },
              s.email,
            ),
        });
      } catch (error) {
        return refused(s, 'confirm_enrollment', error);
      }
    },

    async removeFactor(b, s, input) {
      try {
        const done = await withFactor(b, s, input, 'exclusive', async (tx) => {
          const gone = await tx
            .deleteFrom('totp_credentials')
            .where('user_id', '=', sql<string>`app.current_user_id()`)
            .returning(sql<Date>`now()`.as('at'))
            .executeTakeFirstOrThrow();
          await tx
            .deleteFrom('recovery_codes')
            .where('user_id', '=', sql<string>`app.current_user_id()`)
            .execute();
          const ended = await endOthers(tx, s, b);
          return { at: gone.at, revoked: ended.revoked };
        });
        if (!done.ok) return refused(s, 'remove', done.error);
        quietInfo(deps.logger, 'auth.totp_removed', {
          scope: 'self',
          revoked: done.value.revoked,
          ...ids(s),
        });
        const at = done.value.at;
        return ok({
          send: () =>
            sendFactorNotice(notices, s.userId, { kind: 'second_factor_removed', at }, s.email),
        });
      } catch (error) {
        return refused(s, 'remove', error);
      }
    },

    async replaceRecoveryCodes(b, s, input) {
      try {
        const done = await withFactor(b, s, input, 'exclusive', async (tx, check) => {
          const recoveryCodes = await writeRecoveryCodes(tx, s.userId);
          await dropChallenge(tx);
          return { recoveryCodes, at: check.at };
        });
        if (!done.ok) return refused(s, 'replace_codes', done.error);
        quietInfo(deps.logger, 'auth.recovery_codes_replaced', ids(s));
        const at = done.value.at;
        return ok({
          recoveryCodes: done.value.recoveryCodes,
          setCookies: [],
          send: () =>
            sendFactorNotice(notices, s.userId, { kind: 'recovery_codes_replaced', at }, s.email),
        });
      } catch (error) {
        return refused(s, 'replace_codes', error);
      }
    },

    async stepUpWithFactor(b, s, input) {
      const method: FactorKind = input.kind === 'recovery_code' ? 'recovery_code' : 'totp';
      try {
        const done = await withFactor(b, s, input, 'shared', async (tx, check) => ({
          session: await markStepUp(tx, s, method),
          check,
        }));
        if (!done.ok) {
          logStepUpFailed(deps.logger, s, method, done.error.code);
          return fail(done.error);
        }
        quietInfo(deps.logger, 'auth.step_up_passed', { method, ...ids(s) });
        const { session, check } = done.value;
        const codesLeft = check.codesLeft;
        if (codesLeft !== null) {
          later(() =>
            sendFactorNotice(
              notices,
              s.userId,
              { kind: 'recovery_code_used', codesLeft, at: check.at },
              s.email,
            ),
          );
        }
        return ok(session);
      } catch (error) {
        const result = fail<SessionInfo>(
          error instanceof Refused ? new AuthError(error.code) : unavailable(error),
        );
        if (!result.ok) logStepUpFailed(deps.logger, s, method, result.error.code);
        return result;
      }
    },
  } satisfies SecondFactors);
}

function missing(): never {
  throw new TypeError('createSecondFactors needs db and authDb, or a store and limiter');
}
