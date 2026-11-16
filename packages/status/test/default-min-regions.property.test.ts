import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  StatusError,
  defaultMinRegions,
  newRuleConfig,
  parseRuleConfig,
  voteFloor,
} from '../src/index.ts';

const RUNS = { numRuns: 500 };
const assignedArb = fc.integer({ min: 0, max: 10_000 });

describe('defaultMinRegions', () => {
  it('is never under two unless the team opted out', () => {
    fc.assert(
      fc.property(assignedArb, fc.boolean(), (assigned, majorityDefault) => {
        expect(defaultMinRegions(assigned, false, { majorityDefault })).toBeGreaterThanOrEqual(2);
        expect(defaultMinRegions(assigned, true, { majorityDefault })).toBe(1);
      }),
      RUNS,
    );
  });

  it('is exactly two while status.majority_default is off, and off is the default', () => {
    fc.assert(
      fc.property(assignedArb, (assigned) => {
        expect(defaultMinRegions(assigned, false, { majorityDefault: false })).toBe(2);
        expect(defaultMinRegions(assigned, false)).toBe(2);
      }),
      RUNS,
    );
  });

  it('is a majority of assigned regions with the flag on', () => {
    fc.assert(
      fc.property(assignedArb, (assigned) => {
        const value = defaultMinRegions(assigned, false, { majorityDefault: true });
        expect(value).toBe(Math.max(2, Math.ceil(assigned / 2)));
        expect(2 * value).toBeGreaterThanOrEqual(assigned);
      }),
      RUNS,
    );
    expect(
      [3, 4, 5, 6, 7].map((n) => defaultMinRegions(n, false, { majorityDefault: true })),
    ).toEqual([2, 2, 3, 3, 4]);
  });

  it('refuses a count that is not a non negative safe integer', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ max: -1 }),
          fc.double({ noInteger: true }),
          fc.constant(Number.MAX_SAFE_INTEGER + 1),
        ),
        (assigned) => {
          expect(() => defaultMinRegions(assigned, false)).toThrow(StatusError);
        },
      ),
      RUNS,
    );
  });

  it('flows into new rules, which never fall under the floor', () => {
    fc.assert(
      fc.property(
        assignedArb,
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (assignedRegions, singleRegionOptIn, majorityDefault, autoApplyDefault) => {
          const cfg = newRuleConfig(
            { intervalMs: 60_000, assignedRegions, singleRegionOptIn },
            { majorityDefault, autoApplyDefault },
          );
          expect(cfg.minRegions).toBe(
            defaultMinRegions(assignedRegions, singleRegionOptIn, { majorityDefault }),
          );
          expect(voteFloor(cfg)).toBeGreaterThanOrEqual(singleRegionOptIn ? 1 : 2);
          expect(parseRuleConfig(cfg)).toEqual(cfg);
        },
      ),
      RUNS,
    );
  });

  it('the engine floor holds even for a stored rule that asks for less', () => {
    fc.assert(
      fc.property(fc.integer({ min: -5, max: 1 }), (minRegions) => {
        expect(voteFloor({ minRegions, singleRegionOptIn: false })).toBe(2);
      }),
      RUNS,
    );
  });
});
