import type { UserSchema } from '@drefyn/db';
import type { UserId } from '@drefyn/tenancy';
import { sql, type Transaction } from 'kysely';
import { FACTOR_MAX_AGE_SECONDS } from './cookies.ts';
import type { SessionMethod, SsoScope } from './session-support.ts';

export const FACTOR_CHALLENGE_ATTEMPTS = 5;

// Every transaction that reads "no factor" or inserts a session takes this shared, and
// enrolment and removal take it exclusive. Without it, a session committed just after
// enrolment ended the others would survive with no factor. Taken before any password row
// lock, always, so the two never wait on each other in opposite orders.
export async function lockFactor(
  tx: Transaction<UserSchema>,
  userId: UserId,
  mode: 'shared' | 'exclusive',
): Promise<void> {
  const key = `second_factor:${userId}`;
  await (
    mode === 'shared'
      ? sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`
      : sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`
  ).execute(tx);
}

// A confirmed row is what makes the factor required. Config and flags never enter into it,
// so turning something off cannot drop the protection. A pending enrolment does not count.
export async function hasConfirmedFactor(tx: Transaction<UserSchema>): Promise<boolean> {
  const row = await tx
    .selectFrom('totp_credentials')
    .select('user_id')
    .where('user_id', '=', sql<string>`app.current_user_id()`)
    .where('confirmed_at', 'is not', null)
    .executeTakeFirst();
  return row !== undefined;
}

export interface ChallengeValues {
  readonly userId: UserId;
  readonly secretHash: Buffer;
  readonly method: SessionMethod;
  readonly returnTo: string;
  readonly sso?: SsoScope;
}

// One live challenge per person: a new sign in replaces the old one. Only attempts may be
// updated, so replacing is a delete then an insert; two sign ins racing here fail closed on
// the key.
export async function openChallenge(
  tx: Transaction<UserSchema>,
  values: ChallengeValues,
): Promise<void> {
  await dropChallenge(tx);
  await tx
    .insertInto('factor_challenges')
    .values({
      user_id: values.userId,
      secret_hash: values.secretHash,
      method: values.method,
      return_to: values.returnTo,
      sso_connection_id: values.sso?.connectionId ?? null,
      sso_organization_id: values.sso?.organizationId ?? null,
      expires_at: sql<Date>`now() + interval '${sql.raw(String(FACTOR_MAX_AGE_SECONDS))} seconds'`,
    })
    .execute();
}

// Run by everything that changes how a person proves who they are, so a challenge never
// outlives the credential that earned it.
export async function dropChallenge(tx: Transaction<UserSchema>): Promise<void> {
  await tx
    .deleteFrom('factor_challenges')
    .where('user_id', '=', sql<string>`app.current_user_id()`)
    .execute();
}
