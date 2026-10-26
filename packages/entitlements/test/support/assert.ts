import { expect } from 'vitest';
import { EntitlementError, UNLIMITED } from '../../src/index.ts';

// FC_SEED replays every property under another seed without editing a file. Unset, every
// machine runs the same seed, so a failure reproduces anywhere. fast-check truncates a seed
// to 32 bits, so anything wider is refused rather than quietly run as a different seed.
function seedFrom(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const seed = Number(raw);
  if (!/^-?[0-9]+$/.test(raw) || seed !== (seed | 0)) {
    throw new Error('FC_SEED must be a 32 bit integer');
  }
  return seed;
}

// The first draw from the 'binary' string unit makes fast-check build a reverse lookup over
// every code point, about a million entries, to vet its bias strings. It is cached after
// that, so the property that triggers it pays for all of it: about 0.2 s on a laptop, 1.1 to
// 4.5 s on loaded CI runners with coverage on, and once past the 5 s default. Only that
// property carries this timeout, so move it if the test order changes.
export const FIRST_BINARY_PROPERTY_TIMEOUT_MS = 30_000;

export const SEED = seedFrom(process.env['FC_SEED'], 1108);
export const RUNS = { seed: SEED, numRuns: 400 } as const;

export type ErrorCode =
  | 'ENTITLEMENT_UNKNOWN_TIER'
  | 'ENTITLEMENT_UNKNOWN_LIMIT'
  | 'ENTITLEMENT_UNKNOWN_FEATURE'
  | 'ENTITLEMENT_UNKNOWN_PRODUCT'
  | 'ENTITLEMENT_INVALID_USAGE'
  | 'ENTITLEMENT_INVALID_OVERRIDE'
  | 'ENTITLEMENT_OVERRIDE_LOWERS_LIMIT';

// toThrow(SomeClass) passes on any throw when SomeClass is undefined, so the class and
// the code are checked by hand.
export function expectEntitlementError(
  run: () => unknown,
  code: ErrorCode,
): { readonly code: string; readonly message: string; readonly limitKey?: unknown } {
  let caught: unknown = undefined;
  let threw = false;
  try {
    run();
  } catch (error) {
    threw = true;
    caught = error;
  }
  expect(threw, `expected ${code} but nothing was thrown`).toBe(true);
  expect(typeof EntitlementError).toBe('function');
  expect(caught).toBeInstanceOf(Error);
  expect(caught instanceof EntitlementError).toBe(true);
  expect((caught as { name?: unknown }).name).toBe('EntitlementError');
  expect((caught as { code?: unknown }).code).toBe(code);
  return caught as { code: string; message: string; limitKey?: unknown };
}

export function caughtCode(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    if (!(error instanceof EntitlementError)) throw error;
    return (error as { code: string }).code;
  }
}

export function isLimitValue(value: unknown): boolean {
  return (
    value === UNLIMITED || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  );
}

export type Direction = 'max' | 'min';

// For a max limit more is better; for a min limit (a floor such as the check interval)
// less is better. UNLIMITED is the most generous value either way.
export function atLeastAsGenerous(direction: Direction, a: unknown, b: unknown): boolean {
  if (a === UNLIMITED) return true;
  if (b === UNLIMITED) return false;
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  return direction === 'max' ? a >= b : a <= b;
}
