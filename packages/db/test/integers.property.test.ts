import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DbError } from '../src/errors.ts';
import { toSafeInteger } from '../src/integers.ts';

const SEEDS = [1, 42, 20261026];
const MAX = Number.MAX_SAFE_INTEGER;

function rejects(value: unknown, allowNegative: boolean): boolean {
  try {
    toSafeInteger(value, 'field', { allowNegative });
  } catch (error) {
    return error instanceof DbError && error.code === 'INTEGER_INVALID';
  }
  return false;
}

describe.each(SEEDS)('toSafeInteger with seed %i', (seed) => {
  it('round trips every safe integer through number, bigint and decimal text', () => {
    fc.assert(
      fc.property(fc.integer({ min: -MAX, max: MAX }), (n) => {
        const value = Object.is(n, -0) ? 0 : n;
        const allowNegative = value < 0;
        expect(toSafeInteger(value, 'f', { allowNegative })).toBe(value);
        expect(toSafeInteger(BigInt(value), 'f', { allowNegative })).toBe(value);
        expect(toSafeInteger(String(value), 'f', { allowNegative })).toBe(value);
      }),
      { seed, numRuns: 300 },
    );
  });

  it('rejects every non integer double', () => {
    fc.assert(
      fc.property(
        fc.double().filter((d) => !Number.isSafeInteger(d)),
        fc.boolean(),
        (d, allowNegative) => rejects(d, allowNegative),
      ),
      { seed, numRuns: 300 },
    );
  });

  it('rejects every bigint outside the safe range', () => {
    fc.assert(
      fc.property(
        fc.bigInt().filter((b) => b > BigInt(MAX) || b < BigInt(-MAX)),
        (b) => rejects(b, true) && rejects(String(b), true),
      ),
      { seed, numRuns: 300 },
    );
  });

  it('never throws anything but INTEGER_INVALID on arbitrary input', () => {
    fc.assert(
      fc.property(fc.anything(), fc.boolean(), (value, allowNegative) => {
        try {
          const n = toSafeInteger(value, 'f', { allowNegative });
          return Number.isSafeInteger(n) && (allowNegative || n >= 0);
        } catch (error) {
          return error instanceof DbError && error.code === 'INTEGER_INVALID';
        }
      }),
      { seed, numRuns: 500 },
    );
  });

  it('accepts a string only when it is the canonical text of the number it gives', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 24 }), (text) => {
        try {
          const n = toSafeInteger(text, 'f', { allowNegative: true });
          return String(n) === text;
        } catch (error) {
          return error instanceof DbError && error.code === 'INTEGER_INVALID';
        }
      }),
      { seed, numRuns: 500 },
    );
  });
});
