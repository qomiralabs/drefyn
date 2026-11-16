export interface SealingKey {
  readonly id: string;
  readonly material: Uint8Array;
}

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
  open(row: SealedRow, bound: readonly string[]): Buffer;
}

export type SealErrorCode = 'SEAL_CONFIG_INVALID' | 'SEAL_UNREADABLE' | 'SEAL_UNBOUND';

export class SealError extends Error {
  readonly code: SealErrorCode;
  declare readonly configKey?: string;
  declare readonly reason?: string;

  constructor(code: SealErrorCode) {
    super(code);
    this.code = code;
  }
}

export const SEAL_KEY_ID = /^[a-z0-9]{1,8}$/;
export const MAX_SEAL_KEYS = 8;
export const MIN_SEAL_KEY_BYTES = 32;

export function lengthPrefixed(_parts: readonly string[]): Buffer {
  throw new Error('not built yet');
}

export function aesGcmSealer(
  _keys: readonly SealingKey[],
  _labels: SealLabels,
  _configKey: string,
): Sealer {
  throw new Error('not built yet');
}
