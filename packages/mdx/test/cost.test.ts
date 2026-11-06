import { describe, expect, it } from 'vitest';
import { MAX_GROWTH, SIZE_RATIO, growthOf } from './cost.ts';

const SMALL = 3_000;

// Work the JIT cannot remove, as the result reaches the outside.
let sink = 0;
function linear(size: number): void {
  for (let i = 0; i < size * 4_000; i += 1) sink = (sink + i) % 1_000_003;
}
function quadratic(size: number): void {
  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j < size; j += 1) sink = (sink + i * j) % 1_000_003;
  }
}

describe('the growth check', () => {
  it('passes linear work', { timeout: 60_000 }, () => {
    const growth = growthOf(
      () => {
        linear(SMALL);
      },
      () => {
        linear(SMALL * SIZE_RATIO);
      },
    );
    expect(growth).toBeLessThan(MAX_GROWTH);
  });

  it('catches quadratic work', { timeout: 60_000 }, () => {
    const growth = growthOf(
      () => {
        quadratic(SMALL);
      },
      () => {
        quadratic(SMALL * SIZE_RATIO);
      },
    );
    expect(growth).toBeGreaterThan(MAX_GROWTH);
    expect(sink).toBeGreaterThanOrEqual(0);
  });

  it('ignores work too cheap to read', () => {
    expect(
      growthOf(
        () => undefined,
        () => undefined,
      ),
    ).toBeLessThan(MAX_GROWTH);
  });
});
