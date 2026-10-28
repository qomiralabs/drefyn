import fc from 'fast-check';
import { expect } from 'vitest';
import { AuthError, type AuthConfigKey, type AuthErrorCode } from '../src/index.ts';

// FC_SEED replays every property under another seed without editing a file. Unset, every
// machine runs the same seed, so a failure reproduces anywhere.
function seedFrom(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const seed = Number(raw);
  if (!/^-?[0-9]+$/.test(raw) || seed !== (seed | 0)) {
    throw new Error('FC_SEED must be a 32 bit integer');
  }
  return seed;
}

// Raise numRuns locally to hunt.
export const runs = { seed: seedFrom(process.env['FC_SEED'], 125), numRuns: 300 } as const;

export const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

export const anyUuid: fc.Arbitrary<string> = fc.uuid();
export const secretBytes: fc.Arbitrary<Uint8Array> = fc.uint8Array({
  minLength: 32,
  maxLength: 32,
});

// One UTF-16 code unit, lone surrogates included. Cheaper than the binary string unit,
// whose first draw builds a table over every code point.
export const anyUnit: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 0xffff })
  .map((code) => String.fromCharCode(code));

export interface Mutation {
  readonly kind: 'replace' | 'insert' | 'delete';
  readonly value: string;
}

// Every single character edit of a valid value: one unit replaced, inserted or removed.
export function mutationsOf(valid: string): fc.Arbitrary<Mutation> {
  const index = fc.nat({ max: valid.length - 1 });
  return fc.oneof(
    fc
      .tuple(index, fc.oneof(anyUnit, fc.constantFrom(...Array.from(CROCKFORD))))
      .filter(([i, c]) => valid.charAt(i) !== c)
      .map(([i, c]) => ({
        kind: 'replace' as const,
        value: valid.slice(0, i) + c + valid.slice(i + 1),
      })),
    fc
      .tuple(
        fc.nat({ max: valid.length }),
        fc.oneof(anyUnit, fc.constantFrom(...Array.from(CROCKFORD))),
      )
      .map(([i, c]) => ({
        kind: 'insert' as const,
        value: valid.slice(0, i) + c + valid.slice(i),
      })),
    index.map((i) => ({ kind: 'delete' as const, value: valid.slice(0, i) + valid.slice(i + 1) })),
  );
}

// Lengths around the valid one, and well past it.
export function lengthChangesOf(valid: string): fc.Arbitrary<string> {
  return fc
    .integer({ min: 0, max: valid.length * 3 })
    .filter((n) => n !== valid.length)
    .map((n) => valid.repeat(3).slice(0, n));
}

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export const validEnv = (secret: string = base64url(new Uint8Array(32).fill(7))) =>
  ({
    DREFYN_APP_ORIGIN: 'https://app.drefyn.test',
    DREFYN_AUTH_SECRET: secret,
    UV_THREADPOOL_SIZE: '16',
  }) as const;

export function caught(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

export function expectAuthError(work: () => unknown, code: AuthErrorCode, key?: AuthConfigKey) {
  const error = caught(work);
  expect(error).toBeInstanceOf(AuthError);
  const authError = error as AuthError;
  expect(authError.code).toBe(code);
  if (key !== undefined) expect(authError.key).toBe(key);
  return authError;
}

// Fixed ids for example based tests.
export const UUID_A = '01890a5d-ac96-774b-bcce-b302099a8057';
export const UUID_B = '01890a5d-ac96-774b-bcce-b302099a8058';
