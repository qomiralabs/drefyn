import { describe, expect, it } from 'vitest';
import { durationMs } from '../src/shell/duration.ts';

describe('durationMs', () => {
  it.each([
    ['6000ms', 6000],
    ['6s', 6000],
    [' 0.5s ', 500],
    ['120ms', 120],
  ])('reads %j', (value, ms) => {
    expect(durationMs(value)).toBe(ms);
  });

  it.each(['', '6', 'six seconds', '-1s', 'var(--x)'])('refuses %j', (value) => {
    expect(durationMs(value)).toBeUndefined();
  });
});
