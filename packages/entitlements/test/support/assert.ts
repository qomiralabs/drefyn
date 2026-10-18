import { expect } from 'vitest';
import { EntitlementError, UNLIMITED } from '../../src/index.ts';

// One seed for every property run so a failure replays the same way on every machine.
export const SEED = 1108;
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
export function expectEntitlementError(run: () => unknown, code: ErrorCode): void {
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
