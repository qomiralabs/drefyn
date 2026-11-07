import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BUDGET_MS,
  describeInp,
  inpFigure,
  inpLimit,
  overBudget,
  SHARED_RUNNER_CEILING_MS,
  summarize,
} from '../e2e/inp-summary.ts';

describe('the INP summary', () => {
  it('reads an odd set', () => {
    expect(summarize('a', [120, 64, 96, 72, 88, 104, 80])).toEqual({
      name: 'a',
      samples: 7,
      min: 64,
      median: 88,
      p75: 104,
      max: 120,
    });
  });

  it('takes the lower middle of an even set, and handles one sample', () => {
    expect(summarize('a', [10, 20, 30, 40]).median).toBe(20);
    expect(summarize('a', [8])).toMatchObject({ min: 8, median: 8, p75: 8, max: 8 });
  });

  it('refuses no samples rather than reading zero', () => {
    expect(() => summarize('a', [])).toThrow('no samples');
  });

  it('prints every figure', () => {
    expect(describeInp(summarize('a', [8, 16, 24]))).toBe(
      'INP a: median 16 ms, p75 24 ms, spread 8 to 24 ms over 3 samples',
    );
  });

  it('holds the budget on a quiet bench and the ceiling anywhere else', () => {
    expect(BUDGET_MS).toBe(200);
    expect(inpLimit({ DREFYN_QUIET_BENCH: 'on' })).toBe(BUDGET_MS);
    expect(inpLimit({})).toBe(SHARED_RUNNER_CEILING_MS);
    expect(inpLimit({ DREFYN_QUIET_BENCH: 'off' })).toBe(SHARED_RUNNER_CEILING_MS);
  });

  it('holds p75 on a quiet bench and the median anywhere else', () => {
    expect(inpFigure({ DREFYN_QUIET_BENCH: 'on' })).toBe('p75');
    expect(inpFigure({})).toBe('median');
    expect(inpFigure({ DREFYN_QUIET_BENCH: 'off' })).toBe('median');
  });

  it('names a miss from the budget itself, whatever the limit in force', () => {
    expect(overBudget(summarize('a', [192]))).toBeNull();
    expect(overBudget(summarize('a', [200]))).toBe(
      'INP a: median 200 ms is over the 200 ms budget',
    );
  });

  it('keeps the figures in order, each one a sample', () => {
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 2000 }), { minLength: 1, maxLength: 40 }), (values) => {
        const { min, median, p75, max } = summarize('a', values);
        expect(min).toBeLessThanOrEqual(median);
        expect(median).toBeLessThanOrEqual(p75);
        expect(p75).toBeLessThanOrEqual(max);
        for (const figure of [min, median, p75, max]) expect(values).toContain(figure);
      }),
      { seed: 20261105, numRuns: 500 },
    );
  });
});
