import type { UserSchema } from '@drefyn/db';
import type { UserId } from '@drefyn/tenancy';
import { sql, type Transaction } from 'kysely';
import type { AuthConfig } from './config.ts';
import { AuthError, type AuthErrorCode } from './errors.ts';
import { factorVerifyLimits } from './factor-limits.ts';
import { mintFactorProof, type FactorProof } from './factor-proof.ts';
import type { AuthLogger, AuthMetrics, RateLimiter } from './rate-limiter.ts';
import { isRecoveryCodeShape, matchRecoveryCode, RECOVERY_CODE_COUNT } from './recovery-codes.ts';
import { idFields, quietInfo, quietWarn } from './session-support.ts';
import { isTotpShape, matchTotp, type FactorKind } from './totp.ts';

export interface FactorCode {
  readonly kind: FactorKind;
  readonly code: string;
}

// The ceiling on consecutive TOTP failures. At it, TOTP stays off until a recovery code
// succeeds or an operator removes the factor.
export const FACTOR_FAILURE_CEILING = 100;

// Closed, so a label can never grow from anything a caller sends.
export type FactorOutcome =
  | 'passed'
  | 'matched_previous_step'
  | 'invalid'
  | 'replayed'
  | 'disabled'
  | 'expired'
  | 'rate_limited'
  | 'unavailable';

export type FactorRefusal = Exclude<FactorOutcome, 'passed' | 'matched_previous_step'> | 'origin';

export type FactorCheck =
  | {
      readonly ok: true;
      readonly proof: FactorProof;
      readonly previousStep: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: 'invalid' | 'replayed' | 'disabled' | 'unavailable' | 'not_enrolled';
    };

const KINDS: ReadonlySet<unknown> = new Set<FactorKind>(['totp', 'recovery_code']);

// The kind and shape alone, before any statement. Null for anything a form could send that
// is not a code of the kind it names.
export function factorInput(input: unknown): FactorCode | null {
  if (typeof input !== 'object' || input === null) return null;
  const { kind, code } = input as { kind?: unknown; code?: unknown };
  if (!KINDS.has(kind) || typeof code !== 'string') return null;
  const typed = kind as FactorKind;
  const shaped = typed === 'totp' ? isTotpShape(code) : isRecoveryCodeShape(code);
  return shaped ? { kind: typed, code } : null;
}

export interface FactorContext {
  readonly config: AuthConfig;
  readonly logger: AuthLogger;
}

// The budget for one attempt, each bucket in its own committed transaction, before any
// secret is opened. Only callers that already proved something reach this.
export async function reserveFactor(
  limiter: Pick<RateLimiter, 'reserve'>,
  kind: FactorKind,
  who: { readonly userId: UserId; readonly ip: string },
): Promise<void> {
  for (const { bucket, value } of factorVerifyLimits(kind, who)) {
    await limiter.reserve(bucket, value);
  }
}

// Runs inside a transaction that already holds the shared factor lock. Failures that must
// persist return rather than throw, so the caller commits them.
export async function verifyFactor(
  tx: Transaction<UserSchema>,
  ctx: FactorContext,
  userId: UserId,
  input: FactorCode,
): Promise<FactorCheck> {
  const credential = await tx
    .selectFrom('totp_credentials')
    .select([
      'key_id',
      'secret_nonce',
      'secret_sealed',
      'last_used_step',
      'failed_attempts',
      sql<boolean>`confirmed_at is not null`.as('confirmed'),
      // Database time, so a skewed app clock cannot move the window.
      sql<number>`floor(extract(epoch from now()) / 30)::int`.as('step'),
    ])
    .where('user_id', '=', sql<string>`app.current_user_id()`)
    .executeTakeFirst();
  if (credential?.confirmed !== true) return { ok: false, reason: 'not_enrolled' };
  if (input.kind === 'recovery_code') return spendRecoveryCode(tx, userId, input.code);

  const sealer = ctx.config.totp.sealer;
  const who = idFields({ userId: ['usr', userId] });
  if (sealer === null) {
    quietWarn(ctx.logger, 'auth.totp_key_absent', who);
    return { ok: false, reason: 'unavailable' };
  }
  let secret: Buffer;
  try {
    secret = sealer.open(
      {
        keyId: credential.key_id,
        nonce: credential.secret_nonce,
        sealed: credential.secret_sealed,
      },
      { userId },
    );
  } catch {
    quietWarn(ctx.logger, 'auth.totp_key_unreadable', who);
    return { ok: false, reason: 'unavailable' };
  }
  const matched = matchTotp(secret, input.code, credential.step);
  secret.fill(0);
  if (credential.failed_attempts >= FACTOR_FAILURE_CEILING)
    return { ok: false, reason: 'disabled' };
  if (matched === null) {
    // Saturates, so two failures at 99 both commit instead of one breaking the check.
    await tx
      .updateTable('totp_credentials')
      .set({
        failed_attempts: sql<number>`least("failed_attempts" + 1, ${sql.lit(FACTOR_FAILURE_CEILING)})`,
        updated_at: sql<Date>`now()`,
      })
      .where('user_id', '=', sql<string>`app.current_user_id()`)
      .returning('failed_attempts')
      .executeTakeFirst();
    return { ok: false, reason: 'invalid' };
  }
  // Strictly forward: using a code ends it and every older one. No row back is a replay.
  const moved = await tx
    .updateTable('totp_credentials')
    .set({
      last_used_step: matched,
      failed_attempts: 0,
      last_used_at: sql<Date>`now()`,
      updated_at: sql<Date>`now()`,
    })
    .where('user_id', '=', sql<string>`app.current_user_id()`)
    .where((eb) => eb.or([eb('last_used_step', 'is', null), eb('last_used_step', '<', matched)]))
    .returning('user_id')
    .executeTakeFirst();
  if (moved === undefined) return { ok: false, reason: 'replayed' };
  return {
    ok: true,
    proof: mintFactorProof(userId, 'totp'),
    previousStep: matched === credential.step - 1,
  };
}

async function spendRecoveryCode(
  tx: Transaction<UserSchema>,
  userId: UserId,
  typed: string,
): Promise<FactorCheck> {
  const rows = await tx
    .selectFrom('recovery_codes')
    .select(['id', 'code_hash'])
    .where('user_id', '=', sql<string>`app.current_user_id()`)
    .where('used_at', 'is', null)
    // One past the most a person holds, so a broken read is seen rather than cut short.
    .limit(RECOVERY_CODE_COUNT + 1)
    .execute();
  const id = matchRecoveryCode(
    userId,
    typed,
    rows.map((row) => ({ id: row.id, codeHash: row.code_hash })),
  );
  if (id === null) return { ok: false, reason: 'invalid' };
  // Two tabs spending the same code: one gets the row, the other nothing.
  const spent = await tx
    .updateTable('recovery_codes')
    .set({ used_at: sql<Date>`now()` })
    .where('id', '=', id)
    .where('user_id', '=', sql<string>`app.current_user_id()`)
    .where('used_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  if (spent === undefined) return { ok: false, reason: 'invalid' };
  // A recovery code that works lifts a TOTP lockout.
  await tx
    .updateTable('totp_credentials')
    .set({ failed_attempts: 0, updated_at: sql<Date>`now()` })
    .where('user_id', '=', sql<string>`app.current_user_id()`)
    .execute();
  return { ok: true, proof: mintFactorProof(userId, 'recovery_code'), previousStep: false };
}

export const FACTOR_ERRORS: Readonly<Record<Exclude<FactorRefusal, 'origin'>, AuthErrorCode>> =
  Object.freeze({
    invalid: 'AUTH_FACTOR_INVALID',
    replayed: 'AUTH_FACTOR_INVALID',
    disabled: 'AUTH_FACTOR_DISABLED',
    expired: 'AUTH_FACTOR_CHALLENGE_EXPIRED',
    rate_limited: 'AUTH_RATE_LIMITED',
    unavailable: 'AUTH_UNAVAILABLE',
  });

// The metric and the refusal log for one attempt. Public ids and closed labels only: never
// the code, the cookie or the secret.
export function reportFactor(
  ctx: { readonly logger: AuthLogger; readonly metrics?: AuthMetrics | undefined },
  kind: FactorKind,
  outcome: FactorOutcome | 'origin',
  userId?: UserId,
): void {
  if (outcome !== 'origin') {
    try {
      ctx.metrics?.increment('auth.factor', { outcome, kind });
    } catch {
      // A metric is never worth a failed request.
    }
  }
  if (outcome === 'passed' || outcome === 'matched_previous_step') return;
  quietInfo(ctx.logger, 'auth.factor_refused', {
    reason: outcome,
    kind,
    ...idFields({ userId: ['usr', userId] }),
  });
}

// The error a refusal answers with, keeping a limiter's retry time.
export function factorError(reason: Exclude<FactorRefusal, 'origin'>, cause?: unknown): AuthError {
  if (cause instanceof AuthError && cause.code === FACTOR_ERRORS[reason]) return cause;
  return new AuthError(FACTOR_ERRORS[reason]);
}
