import fc from 'fast-check';
import { expect } from 'vitest';
import { TenancyError, type TenancyErrorCode } from '../src/index.ts';

// Fixed seed so a failure reproduces on every machine. Raise numRuns locally to hunt.
export const runs = { seed: 20, numRuns: 500 } as const;

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const NIL_UUID = '00000000-0000-0000-0000-000000000000';
export const MAX_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

export const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

export const PREFIXES = [
  'org',
  'prj',
  'usr',
  'mem',
  'key',
  'nod',
  'ver',
  'ast',
  'cmp',
  'inc',
  'sub',
  'whk',
  'evt',
  'crd',
] as const;

export const SCOPES = ['page', 'nav', 'search', 'retrieval', 'render', 'asset'] as const;

function hex128(value: bigint): string {
  const h = value.toString(16).padStart(32, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Any 128 bit value, not only RFC versions, so the codec is tested at both ends of the range.
export const anyUuid: fc.Arbitrary<string> = fc.oneof(
  fc.uuid(),
  fc.bigInt({ min: 0n, max: (1n << 128n) - 1n }).map(hex128),
  fc.constantFrom(NIL_UUID, MAX_UUID),
);

// Written independently of the package: BigInt arithmetic, big endian, 26 symbols.
export function oracleBody(uuid: string): string {
  let n = BigInt(`0x${uuid.replaceAll('-', '')}`);
  let out = '';
  for (let i = 0; i < 26; i += 1) {
    out = (CROCKFORD[Number(n & 31n)] ?? '') + out;
    n >>= 5n;
  }
  return out;
}

export function codeOf(run: () => unknown): TenancyErrorCode | 'no error' | 'not a TenancyError' {
  try {
    run();
  } catch (error) {
    return error instanceof TenancyError ? error.code : 'not a TenancyError';
  }
  return 'no error';
}

export function expectCode(run: () => unknown, code: TenancyErrorCode): void {
  expect(codeOf(run)).toBe(code);
}
