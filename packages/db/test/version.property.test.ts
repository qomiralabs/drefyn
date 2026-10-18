import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareVersions, meetsVersionFloor, parseVersion } from '../src/version.ts';

const part = fc.nat({ max: 100_000 });
const triple = fc.tuple(part, part, part);
const text = ([a, b, c]: readonly [number, number, number]) => `${a}.${b}.${c}`;
const params = { seed: 1414, numRuns: 500 };

const lexical = (x: readonly number[], y: readonly number[]): number => {
  for (let i = 0; i < 3; i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
};

describe('version comparison properties', () => {
  it('parses what it prints', () => {
    fc.assert(
      fc.property(triple, (t) => {
        expect(parseVersion(text(t))).toEqual(t);
      }),
      params,
    );
  });

  it('agrees with a numeric tuple comparison', () => {
    fc.assert(
      fc.property(triple, triple, (a, b) => {
        expect(compareVersions(text(a), text(b))).toBe(lexical(a, b));
      }),
      params,
    );
  });

  it('is antisymmetric and reflexive', () => {
    fc.assert(
      fc.property(triple, triple, (a, b) => {
        expect(compareVersions(text(a), text(b))).toBe(-compareVersions(text(b), text(a)) || 0);
        expect(compareVersions(text(a), text(a))).toBe(0);
      }),
      params,
    );
  });

  it('is transitive', () => {
    fc.assert(
      fc.property(triple, triple, triple, (a, b, c) => {
        const ab = compareVersions(text(a), text(b));
        const bc = compareVersions(text(b), text(c));
        if (ab <= 0 && bc <= 0) expect(compareVersions(text(a), text(c))).toBeLessThanOrEqual(0);
      }),
      params,
    );
  });

  it('meets the floor exactly when it compares at or above it', () => {
    fc.assert(
      fc.property(triple, (t) => {
        expect(meetsVersionFloor(text(t))).toBe(lexical(t, [0, 8, 2]) >= 0);
      }),
      params,
    );
  });

  it('never accepts a string that does not parse', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        if (parseVersion(s) === undefined) expect(meetsVersionFloor(s)).toBe(false);
      }),
      params,
    );
  });
});
