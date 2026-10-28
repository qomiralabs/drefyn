import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_GROWTH_LIMIT,
  KB,
  ROUTE_BUDGET_BYTES,
  baselineReport,
  routeReport,
} from '../src/index.ts';
import { SEEDS } from './seeds.ts';

// Built once so no seed pays for constructing the arbitrary.
const script = fc.record({
  url: fc.constantFrom('/a.js', '/b.js', '/c.js', '/d.js', '/e.js'),
  gzipBytes: fc.nat({ max: 500_000 }),
});

const framework = [
  { url: '/_next/static/chunks/framework.js', gzipBytes: 60_000 },
  { url: '/_next/static/chunks/main.js', gzipBytes: 71_800 },
];

describe('routeReport', () => {
  it('counts only scripts the baseline route does not load', () => {
    const report = routeReport(
      '/acme',
      [...framework, { url: '/_next/static/chunks/shell.js', gzipBytes: 64_200 }],
      framework,
    );
    expect(report).toEqual({
      route: '/acme',
      totalBytes: 196_000,
      beyondBaselineBytes: 64_200,
      overBudget: false,
    });
  });

  it('is within budget at exactly 150 KB and over at one byte more', () => {
    const at = [...framework, { url: '/a.js', gzipBytes: ROUTE_BUDGET_BYTES }];
    const over = [...framework, { url: '/a.js', gzipBytes: ROUTE_BUDGET_BYTES + 1 }];
    expect(routeReport('/at', at, framework).overBudget).toBe(false);
    expect(routeReport('/over', over, framework).overBudget).toBe(true);
    expect(ROUTE_BUDGET_BYTES).toBe(150 * KB);
  });

  it('counts a script loaded twice once', () => {
    const shell = { url: '/_next/static/chunks/shell.js', gzipBytes: 10_000 };
    expect(routeReport('/x', [...framework, shell, shell], framework).beyondBaselineBytes).toBe(
      10_000,
    );
  });

  it.each(SEEDS)('never reports more beyond the baseline than in total (seed %i)', (seed) => {
    fc.assert(
      fc.property(fc.array(script), fc.array(script), (route, base) => {
        const report = routeReport('/r', route, base);
        expect(report.beyondBaselineBytes).toBeGreaterThanOrEqual(0);
        expect(report.beyondBaselineBytes).toBeLessThanOrEqual(report.totalBytes);
        expect(report.overBudget).toBe(report.beyondBaselineBytes > ROUTE_BUDGET_BYTES);
      }),
      { seed, numRuns: 200 },
    );
  });
});

describe('baselineReport', () => {
  it('allows the baseline to grow by up to 5 percent', () => {
    expect(BASELINE_GROWTH_LIMIT).toBe(0.05);
    expect(baselineReport(100_000, 105_000)).toEqual({
      recordedBytes: 100_000,
      measuredBytes: 105_000,
      growth: 0.05,
      ok: true,
    });
  });

  it('fails one byte past 5 percent', () => {
    const report = baselineReport(100_000, 105_001);
    expect(report.ok).toBe(false);
    expect(report.growth).toBeCloseTo(0.05001, 6);
  });

  it('passes a smaller baseline and reports the shrink', () => {
    const report = baselineReport(131_800, 120_000);
    expect(report.ok).toBe(true);
    expect(report.growth).toBeLessThan(0);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    'refuses a recorded value of %d',
    (recorded) => {
      expect(() => baselineReport(recorded, 100_000)).toThrow(RangeError);
    },
  );
});
