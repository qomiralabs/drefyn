import {
  MAX_SEAL_KEYS,
  SEAL_KEY_ID,
  SealError,
  aesGcmSealer as sealWith,
  type SealLabels,
  type SealedRow,
  type SealedSecret,
  type Sealer,
  type SealingKey,
} from '@drefyn/seal';
import type { UserId } from '@drefyn/tenancy';
import { AuthError } from './errors.ts';

export type { SealedRow, SealedSecret, SealingKey };

export interface SealContext {
  readonly userId: UserId;
}

// The open core keeps keys in the environment; a hosted build may supply a key service
// behind the same two calls.
export interface SecretSealer {
  seal(plain: Uint8Array, context: SealContext): SealedSecret;
  // Throws AUTH_UNAVAILABLE for an unknown key, a tampered row or the wrong user.
  open(row: SealedRow, context: SealContext): Buffer;
}

export const TOTP_KEY_ID = SEAL_KEY_ID;
export const MAX_TOTP_KEYS = MAX_SEAL_KEYS;

// Part of the stored format: changing one strands every enrolled second factor. Versioned
// rather than edited, and pinned by known value tests.
export const TOTP_SEAL_LABELS: SealLabels = Object.freeze({
  hkdfSalt: 'drefyn.auth.totp.v1',
  hkdfInfo: 'drefyn/auth/v1/totp',
  aadVersion: 'drefyn.totp_secret.v1',
});

// The user id is the one bound value, so the associated data stays version, user, key id.
const boundTo = (context: SealContext) => [context.userId];

// Seal errors become auth errors with no cause, so nothing beneath leaks into auth logs.
function asAuthError(error: unknown): never {
  if (error instanceof SealError && error.code === 'SEAL_CONFIG_INVALID') {
    throw new AuthError('AUTH_CONFIG_INVALID', {
      key: 'DREFYN_AUTH_TOTP_KEYS',
      reason: error.reason ?? 'is invalid',
    });
  }
  throw new AuthError('AUTH_UNAVAILABLE');
}

export function aesGcmSealer(keys: readonly SealingKey[]): SecretSealer {
  let sealer: Sealer;
  try {
    sealer = sealWith(keys, TOTP_SEAL_LABELS, 'DREFYN_AUTH_TOTP_KEYS');
  } catch (error) {
    return asAuthError(error);
  }
  return Object.freeze({
    // Always one bound value, so seal has no refusal to translate.
    seal: (plain: Uint8Array, context: SealContext): SealedSecret =>
      sealer.seal(plain, boundTo(context)),
    open(row: SealedRow, context: SealContext): Buffer {
      try {
        return sealer.open(row, boundTo(context));
      } catch (error) {
        return asAuthError(error);
      }
    },
  });
}
