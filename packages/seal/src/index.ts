import {
  createCipheriv,
  createDecipheriv,
  createSecretKey,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

export interface SealingKey {
  // The same shape a key_id column accepts.
  readonly id: string;
  readonly material: Uint8Array;
}

// Part of the stored format. Versioned rather than edited: changing one strands every value
// sealed under it.
export interface SealLabels {
  readonly hkdfSalt: string;
  readonly hkdfInfo: string;
  readonly aadVersion: string;
}

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

export interface Sealer {
  seal(plain: Uint8Array, bound: readonly string[]): SealedSecret;
  // Throws SEAL_UNREADABLE for an unknown key, a tampered row, other bound values or other
  // labels, without saying which.
  open(row: SealedRow, bound: readonly string[]): Buffer;
}

export type SealErrorCode = 'SEAL_CONFIG_INVALID' | 'SEAL_UNREADABLE' | 'SEAL_UNBOUND';

const MESSAGES: Record<SealErrorCode, string> = {
  SEAL_CONFIG_INVALID: 'the keyring is invalid',
  SEAL_UNREADABLE: 'the sealed value cannot be opened',
  SEAL_UNBOUND: 'a sealed value must be bound to at least one value',
};

// Never takes a cause: the crypto error underneath can carry buffers.
export class SealError extends Error {
  readonly code: SealErrorCode;
  declare readonly configKey?: string;
  declare readonly reason?: string;

  constructor(code: SealErrorCode, detail: { configKey?: string; reason?: string } = {}) {
    const text =
      detail.reason === undefined
        ? MESSAGES[code]
        : [detail.configKey, detail.reason].filter((part) => part !== undefined).join(' ');
    super(`${code}: ${text}`);
    this.code = code;
    if (detail.configKey !== undefined) this.configKey = detail.configKey;
    if (detail.reason !== undefined) this.reason = detail.reason;
  }
}

// On the prototype, so serialising an error shows only code, config key and reason.
Object.defineProperty(SealError.prototype, 'name', { value: 'SealError', enumerable: false });

export const SEAL_KEY_ID = /^[a-z0-9]{1,8}$/;
export const MAX_SEAL_KEYS = 8;
export const MIN_SEAL_KEY_BYTES = 32;

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const LABEL_NAMES = ['hkdfSalt', 'hkdfInfo', 'aadVersion'] as const;

// Each part carries a 4 byte length, so ("ab", "c") and ("a", "bc") never collide and a
// caller cannot shift bytes from one bound value into the next.
export function lengthPrefixed(parts: readonly string[]): Buffer {
  return Buffer.concat(
    parts.flatMap((part) => {
      const bytes = Buffer.from(part, 'utf8');
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length);
      return [length, bytes];
    }),
  );
}

// One error for every failure, so a caller cannot tell a wrong key from a moved row.
function unreadable(): never {
  throw new SealError('SEAL_UNREADABLE');
}

// An unbound row could be copied to any owner and still open.
function requireBound(bound: readonly string[]): void {
  if (bound.length === 0) throw new SealError('SEAL_UNBOUND');
}

// Reasons name an entry by position and never its id or material.
export function aesGcmSealer(
  keys: readonly SealingKey[],
  labels: SealLabels,
  configKey: string,
): Sealer {
  if (configKey === '') {
    throw new SealError('SEAL_CONFIG_INVALID', { reason: 'config key name must not be empty' });
  }
  const refuse = (reason: string): never => {
    throw new SealError('SEAL_CONFIG_INVALID', { configKey, reason });
  };
  for (const name of LABEL_NAMES) {
    if (labels[name] === '') refuse(`label ${name} must not be empty`);
  }
  // Read once, so a caller changing the object later cannot change what rows are bound to.
  const { hkdfSalt, hkdfInfo, aadVersion } = labels;
  if (keys.length === 0) refuse('must list at least one key');
  if (keys.length > MAX_SEAL_KEYS) refuse(`must list at most ${MAX_SEAL_KEYS} keys`);

  const ring = new Map<string, KeyObject>();
  keys.forEach((key, index) => {
    const entry = `entry ${index + 1}`;
    if (!SEAL_KEY_ID.test(key.id)) {
      refuse(`${entry} needs an id of 1 to 8 lowercase letters or digits`);
    }
    if (key.material.length < MIN_SEAL_KEY_BYTES) {
      refuse(`${entry} must be at least 32 random bytes`);
    }
    if (ring.has(key.id)) refuse(`${entry} repeats the id of an earlier entry`);
    // HKDF takes any key of 32 bytes or more, and keeps this key apart from any other
    // purpose an operator might have reused the same value for.
    ring.set(
      key.id,
      createSecretKey(Buffer.from(hkdfSync('sha256', key.material, hkdfSalt, hkdfInfo, 32))),
    );
  });
  const sealId = keys[0]?.id ?? '';
  const sealKey = ring.get(sealId);
  if (sealKey === undefined) return refuse('must list at least one key');

  const associatedData = (bound: readonly string[], keyId: string) =>
    lengthPrefixed([aadVersion, ...bound, keyId]);

  return Object.freeze({
    seal(plain: Uint8Array, bound: readonly string[]): SealedSecret {
      requireBound(bound);
      // 96 random bits per seal. Callers seal a few times per owner, far below the count at
      // which random nonces start to repeat under one key.
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', sealKey, nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(associatedData(bound, sealId));
      const sealed = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
      return Object.freeze({ keyId: sealId, nonce, sealed });
    },
    open(row: SealedRow, bound: readonly string[]): Buffer {
      requireBound(bound);
      const key = ring.get(row.keyId);
      if (key === undefined) unreadable();
      if (row.nonce.length !== NONCE_BYTES || row.sealed.length <= TAG_BYTES) unreadable();
      const body = row.sealed.subarray(0, row.sealed.length - TAG_BYTES);
      const tag = row.sealed.subarray(row.sealed.length - TAG_BYTES);
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, row.nonce, {
          authTagLength: TAG_BYTES,
        });
        decipher.setAAD(associatedData(bound, row.keyId));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]);
      } catch {
        return unreadable();
      }
    },
  });
}
