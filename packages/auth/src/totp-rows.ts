import type { UserId } from '@drefyn/tenancy';
import type { SealedSecret } from './secret-sealer.ts';

// Spelled out rather than imported from the database package, which only the store modules
// may reach. It matches the insertable columns of app.totp_credentials.
export interface PendingTotpRow {
  readonly user_id: UserId;
  readonly key_id: string;
  readonly secret_nonce: Buffer;
  readonly secret_sealed: Buffer;
  readonly confirmed_at: null;
  readonly last_used_step: null;
  readonly last_used_at: null;
  readonly failed_attempts: 0;
}

// The row startEnrollment writes. Every state column is set explicitly rather than left to
// a default, because insert covers them all and a confirmed or used row here would let a
// secret nobody proved guard the account.
export function pendingTotpRow(userId: UserId, sealed: SealedSecret): PendingTotpRow {
  return {
    user_id: userId,
    key_id: sealed.keyId,
    secret_nonce: sealed.nonce,
    secret_sealed: sealed.sealed,
    confirmed_at: null,
    last_used_step: null,
    last_used_at: null,
    failed_attempts: 0,
  };
}
