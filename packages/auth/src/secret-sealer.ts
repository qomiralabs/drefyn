import {
  createCipheriv,
  createDecipheriv,
  createSecretKey,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import type { UserId } from '@drefyn/tenancy';
import { AuthError } from './errors.ts';
import { MIN_SECRET_BYTES, lengthPrefixed } from './keys.ts';

export interface SealedSecret {
  readonly keyId: string;
  readonly nonce: Buffer;
  readonly sealed: Buffer;
}

export interface SealedRow {
  readonly keyId: string;
  readonly nonce: Uint8Array;
  readonly sealed: Uint8Array;
}

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

export interface SealingKey {
  // The same shape the key_id column accepts.
  readonly id: string;
  readonly material: Uint8Array;
}

export const TOTP_KEY_ID = /^[a-z0-9]{1,8}$/;
export const MAX_TOTP_KEYS = 8;

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
// Versioned rather than edited: changing a label strands every stored secret.
const HKDF_SALT = 'drefyn.auth.totp.v1';
const HKDF_INFO = 'drefyn/auth/v1/totp';
const AAD_VERSION = 'drefyn.totp_secret.v1';

function refuseKeys(reason: string): never {
  throw new AuthError('AUTH_CONFIG_INVALID', { key: 'DREFYN_AUTH_TOTP_KEYS', reason });
}

// One message for every failure, so a caller cannot tell a wrong key from a moved row.
function unreadable(): never {
  throw new AuthError('AUTH_UNAVAILABLE');
}

const associatedData = (userId: string, keyId: string) =>
  lengthPrefixed([AAD_VERSION, userId, keyId]);

// Reasons name an entry by position and never its id or material.
export function aesGcmSealer(keys: readonly SealingKey[]): SecretSealer {
  if (keys.length === 0) refuseKeys('must list at least one key');
  if (keys.length > MAX_TOTP_KEYS) refuseKeys(`must list at most ${MAX_TOTP_KEYS} keys`);
  const ring = new Map<string, KeyObject>();
  keys.forEach((key, index) => {
    const entry = `entry ${index + 1}`;
    if (!TOTP_KEY_ID.test(key.id)) {
      refuseKeys(`${entry} needs an id of 1 to 8 lowercase letters or digits`);
    }
    if (key.material.length < MIN_SECRET_BYTES) {
      refuseKeys(`${entry} must be at least 32 random bytes`);
    }
    if (ring.has(key.id)) refuseKeys(`${entry} repeats the id of an earlier entry`);
    // HKDF takes any key of 32 bytes or more, and keeps this key apart from any other
    // purpose an operator might have reused the same value for.
    ring.set(
      key.id,
      createSecretKey(Buffer.from(hkdfSync('sha256', key.material, HKDF_SALT, HKDF_INFO, 32))),
    );
  });
  const sealId = keys[0]?.id ?? '';
  const sealKey = ring.get(sealId);
  if (sealKey === undefined) return refuseKeys('must list at least one key');

  return Object.freeze({
    seal(plain: Uint8Array, context: SealContext): SealedSecret {
      // 96 random bits per seal. Enrolment seals a few times per person, far below the
      // count at which random nonces start to repeat under one key.
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', sealKey, nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(associatedData(context.userId, sealId));
      const sealed = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
      return Object.freeze({ keyId: sealId, nonce, sealed });
    },
    open(row: SealedRow, context: SealContext): Buffer {
      const key = ring.get(row.keyId);
      if (key === undefined) unreadable();
      if (row.nonce.length !== NONCE_BYTES || row.sealed.length <= TAG_BYTES) unreadable();
      const body = row.sealed.subarray(0, row.sealed.length - TAG_BYTES);
      const tag = row.sealed.subarray(row.sealed.length - TAG_BYTES);
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, row.nonce, {
          authTagLength: TAG_BYTES,
        });
        decipher.setAAD(associatedData(context.userId, row.keyId));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]);
      } catch {
        return unreadable();
      }
    },
  });
}
