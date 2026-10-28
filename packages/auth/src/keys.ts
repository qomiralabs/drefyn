import {
  createHash,
  createHmac,
  createSecretKey,
  hkdfSync,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import { AuthError } from './errors.ts';

export const KEY_PURPOSES = Object.freeze(['code', 'rate', 'csrf'] as const);
export type KeyPurpose = (typeof KEY_PURPOSES)[number];
export type MacPart = string | Uint8Array;

export const MIN_SECRET_BYTES = 32;

// Changing either label orphans every stored code HMAC and rate limit key, so they are
// versioned rather than edited.
const HKDF_SALT = 'drefyn.auth.hkdf.v1';
const hkdfInfo = (purpose: KeyPurpose) => `drefyn/auth/v1/${purpose}`;

const bytesOf = (part: MacPart): Buffer =>
  typeof part === 'string' ? Buffer.from(part, 'utf8') : Buffer.from(part);

// Each part carries a 4 byte length, so ("ab", "c") and ("a", "bc") never collide and a
// caller cannot shift bytes from one field into the next.
export function lengthPrefixed(parts: readonly MacPart[]): Buffer {
  return Buffer.concat(
    parts.flatMap((part) => {
      const bytes = bytesOf(part);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length);
      return [length, bytes];
    }),
  );
}

// Lengths are not secret here (every value compared is a fixed size digest), but a
// mismatch still runs one compare so callers get no early exit to time.
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function sha256(data: MacPart): Buffer {
  return createHash('sha256').update(bytesOf(data)).digest();
}

export interface AuthKeys {
  // Always made with the current secret.
  mac(purpose: KeyPurpose, parts: readonly MacPart[]): Buffer;
  // Accepts the current secret and, during a rotation, the previous one. Rate limit keys
  // are lookups, not proofs, so they have no verify and simply start fresh windows.
  verify(purpose: 'code' | 'csrf', parts: readonly MacPart[], expected: Uint8Array): boolean;
  readonly rotating: boolean;
}

type Subkeys = Readonly<Record<KeyPurpose, KeyObject>>;

function subkeys(
  secret: Uint8Array,
  name: 'DREFYN_AUTH_SECRET' | 'DREFYN_AUTH_SECRET_PREVIOUS',
): Subkeys {
  if (secret.length < MIN_SECRET_BYTES) {
    throw new AuthError('AUTH_CONFIG_INVALID', { key: name, reason: 'must be at least 32 bytes' });
  }
  // KeyObjects are made once: one per call cost about 15 microseconds each.
  const derive = (purpose: KeyPurpose) =>
    createSecretKey(Buffer.from(hkdfSync('sha256', secret, HKDF_SALT, hkdfInfo(purpose), 32)));
  return { code: derive('code'), rate: derive('rate'), csrf: derive('csrf') };
}

function macWith(key: KeyObject, parts: readonly MacPart[]): Buffer {
  return createHmac('sha256', key).update(lengthPrefixed(parts)).digest();
}

// Key material lives only in closures, so serialising or inspecting the result shows
// nothing but whether a rotation is under way.
export function deriveAuthKeys(secret: Uint8Array, previous?: Uint8Array | null): AuthKeys {
  const current = subkeys(secret, 'DREFYN_AUTH_SECRET');
  const old =
    previous === undefined || previous === null
      ? null
      : subkeys(previous, 'DREFYN_AUTH_SECRET_PREVIOUS');
  return Object.freeze({
    rotating: old !== null,
    mac: (purpose: KeyPurpose, parts: readonly MacPart[]) => macWith(current[purpose], parts),
    verify: (purpose: 'code' | 'csrf', parts: readonly MacPart[], expected: Uint8Array) => {
      const now = constantTimeEqual(macWith(current[purpose], parts), expected);
      // Both are always computed, so timing does not say which secret matched.
      const before = old !== null && constantTimeEqual(macWith(old[purpose], parts), expected);
      return now || before;
    },
  });
}
