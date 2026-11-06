import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatUnits, parseUnits, type Scale } from '../src/index.ts';
import './support.ts';

const INT8_MAX = 9_223_372_036_854_775_807n;
const INT8_MIN = -9_223_372_036_854_775_808n;

describe('parseUnits', () => {
  it.each<[string, Scale, bigint]>([
    ['0', 0, 0n],
    ['12', 0, 12n],
    ['-12', 0, -12n],
    ['1.5', 1, 15n],
    ['1.5', 2, 150n],
    ['1.50', 2, 150n],
    ['0.000001', 6, 1n],
    ['-0.01', 2, -1n],
    ['-0', 2, 0n],
    ['9223372036854775807', 0, INT8_MAX],
    ['-9223372036854775808', 0, INT8_MIN],
    ['9223372036854.775807', 6, INT8_MAX],
  ])('reads %s at scale %i', (value, scale, units) => {
    expect(parseUnits(value, scale)).toBe(units);
  });

  it.each<[string, Scale]>([
    ['', 0],
    ['-', 0],
    ['.5', 1],
    ['1.', 1],
    ['+1', 0],
    ['01', 0],
    ['1e3', 0],
    ['1.5', 0],
    ['1.005', 2],
    ['0x10', 0],
    [' 1', 0],
    ['1\n', 0],
    ['NaN', 0],
    ['Infinity', 0],
    ['1,5', 1],
    ['١', 0],
    ['9223372036854775808', 0],
    ['-9223372036854775809', 0],
    ['9223372036854.775808', 6],
    ['1'.repeat(10_000), 0],
  ])('refuses %j at scale %i', (value, scale) => {
    expect(parseUnits(value, scale)).toBeNull();
  });
});

describe('formatUnits', () => {
  it.each<[bigint, Scale, string]>([
    [0n, 0, '0'],
    [15n, 1, '1.5'],
    [150n, 2, '1.50'],
    [-1n, 2, '-0.01'],
    [1n, 6, '0.000001'],
    [-1500n, 3, '-1.500'],
    [INT8_MIN, 6, '-9223372036854.775808'],
  ])('writes %s at scale %i', (units, scale, value) => {
    expect(formatUnits(units, scale)).toBe(value);
  });

  it('round trips every int8 at every scale', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: INT8_MIN, max: INT8_MAX }),
        fc.constantFrom<Scale>(0, 1, 2, 3, 4, 5, 6),
        (units, scale) => {
          expect(parseUnits(formatUnits(units, scale), scale)).toBe(units);
        },
      ),
    );
  });
});
