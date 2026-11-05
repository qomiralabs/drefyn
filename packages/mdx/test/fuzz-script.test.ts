import { describe, expect, it } from 'vitest';
import { fuzz } from '../fuzz/target.ts';

describe('the fuzz target', () => {
  it('finishes a short run with nothing to report', () => {
    const report = fuzz({ seconds: 1, seed: 7 });
    expect(report.failure).toBeUndefined();
    expect(report.runs).toBeGreaterThan(0);
  });

  it('would catch a parser that loses a byte', () => {
    const report = fuzz({
      seconds: 1,
      seed: 7,
      check: (source) => !source.includes('\r'),
    });
    expect(report.failure).toBeDefined();
  });
});
