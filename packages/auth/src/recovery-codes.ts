import { randomBytes } from 'node:crypto';
import type { UserId } from '@drefyn/tenancy';
import { AuthError } from './errors.ts';
import { constantTimeEqual, lengthPrefixed, sha256 } from './keys.ts';

export const RECOVERY_CODE_COUNT = 10;
// 120 bits: past the 112 at which a plain hash is enough, so no key is needed and a lost
// TOTP key or a rotated auth secret never breaks a recovery code.
const CODE_BYTES = 15;
const GROUP = 6;
// The lowercase Crockford alphabet the other tokens use: no i, l, o or u to misread.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const SHAPE = /^[0-9a-hjkmnp-tv-z]{24}$/;
// Four groups of six with hyphens, and room for spaces a person adds.
const MAX_TYPED = 64;
// Versioned rather than edited: a new label orphans every stored hash.
const HASH_LABEL = 'drefyn.recovery_code.v1';
// Compared against when the input is malformed, so the work does not depend on its shape.
const NO_MATCH = Buffer.alloc(32);

export interface NewRecoveryCode {
  // Shown once, as xxxxxx-xxxxxx-xxxxxx-xxxxxx.
  readonly code: string;
  readonly hash: Buffer;
}

export interface RecoveryCodeRow {
  readonly id: string;
  readonly codeHash: Uint8Array;
}

// 15 bytes are exactly 24 symbols of 5 bits, so every symbol is uniform and none is padding.
function encode(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = ((acc << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET.charAt((acc >> bits) & 31);
    }
  }
  return out;
}

const grouped = (plain: string) =>
  [0, 1, 2, 3].map((i) => plain.slice(i * GROUP, (i + 1) * GROUP)).join('-');

// Hyphens and gaps out, lower case, then exactly the alphabet. Null for anything else.
function cleaned(typed: string): string | null {
  if (typed.length > MAX_TYPED) return null;
  const plain = typed.replace(/[\s-]/g, '').toLowerCase();
  return SHAPE.test(plain) ? plain : null;
}

// Bound to the person, so a hash copied to another person's rows matches nothing, and one
// precomputed table cannot serve every account.
const hashOf = (userId: UserId, plain: string) =>
  sha256(lengthPrefixed([HASH_LABEL, userId, plain]));

// Whether the input could be a recovery code at all, whoever it belongs to.
export function isRecoveryCodeShape(typed: string): boolean {
  return cleaned(typed) !== null;
}

export function recoveryCodeHash(userId: UserId, typed: string): Buffer | null {
  const plain = cleaned(typed);
  return plain === null ? null : hashOf(userId, plain);
}

export function newRecoveryCodes(userId: UserId): readonly NewRecoveryCode[] {
  const codes: NewRecoveryCode[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i += 1) {
    const plain = encode(randomBytes(CODE_BYTES));
    codes.push(Object.freeze({ code: grouped(plain), hash: hashOf(userId, plain) }));
  }
  return Object.freeze(codes);
}

// The id of the row the input matches, or null. Every row is compared, with no early exit,
// so timing says nothing about which row matched or whether the input was well formed.
export function matchRecoveryCode(
  userId: UserId,
  typed: string,
  rows: readonly RecoveryCodeRow[],
): string | null {
  // A person never holds more; more means the read went wrong, so refuse rather than guess.
  if (rows.length > RECOVERY_CODE_COUNT) throw new AuthError('AUTH_UNAVAILABLE');
  const hash = recoveryCodeHash(userId, typed);
  let matched: string | null = null;
  for (const row of rows) {
    const same = constantTimeEqual(row.codeHash, hash ?? NO_MATCH);
    if (same && hash !== null) matched = row.id;
  }
  return matched;
}
