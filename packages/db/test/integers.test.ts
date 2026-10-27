import { describe, expect, it } from 'vitest';
import { DbError } from '../src/errors.ts';
import { toSafeInteger } from '../src/integers.ts';
import { errorText, thrown } from './support.ts';

const MAX = Number.MAX_SAFE_INTEGER;

function code(fn: () => unknown): string {
  const error = thrown(fn);
  return error instanceof DbError ? error.code : `not a DbError: ${String(error)}`;
}

describe('toSafeInteger', () => {
  it.each([
    [0, 0],
    [1, 1],
    [42, 42],
    [MAX, MAX],
    [0n, 0],
    [BigInt(MAX), MAX],
    ['0', 0],
    ['17', 17],
    [String(MAX), MAX],
  ])('accepts %s', (value, expected) => {
    expect(toSafeInteger(value, 'amount_cents')).toBe(expected);
  });

  it('turns negative zero into zero', () => {
    expect(Object.is(toSafeInteger(-0, 'amount_cents'), 0)).toBe(true);
  });

  it.each([
    ['a fraction', 1.5],
    ['a tiny fraction', 0.000001],
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
    ['2^53', MAX + 1],
    ['2^53 + 2', MAX + 2],
    ['1e21', 1e21],
    ['a bigint above the range', BigInt(MAX) + 1n],
    ['a string above the range', '9007199254740992'],
    ['a decimal string', '1.5'],
    ['a string with a trailing .0', '1.0'],
    ['an exponent string', '1e3'],
    ['a hex string', '0x10'],
    ['a string with a plus sign', '+1'],
    ['a string with a leading zero', '01'],
    ['a string with spaces', ' 1'],
    ['a string with a trailing newline', '1\n'],
    ['an empty string', ''],
    ['full width digits', '１'],
    ['a boolean', true],
    ['null', null],
    ['undefined', undefined],
    ['an object', { valueOf: () => 1 }],
    ['an array', [1]],
    ['a Number object', Object(1) as unknown],
  ])('rejects %s with INTEGER_INVALID', (_label, value) => {
    expect(code(() => toSafeInteger(value, 'amount_cents'))).toBe('INTEGER_INVALID');
  });

  it.each([[-1], [-MAX], [-1n], ['-1']])('rejects the negative %s by default', (value) => {
    expect(code(() => toSafeInteger(value, 'amount_cents'))).toBe('INTEGER_INVALID');
  });

  it.each([
    [-1, -1],
    [-MAX, -MAX],
    [-1n, -1],
    ['-17', -17],
    [String(-MAX), -MAX],
  ])('accepts the negative %s when negatives are allowed', (value, expected) => {
    expect(toSafeInteger(value, 'balance_credits', { allowNegative: true })).toBe(expected);
  });

  it.each([[-MAX - 1], [BigInt(-MAX) - 1n], ['-9007199254740992'], ['-0'], ['-']])(
    'still rejects %s when negatives are allowed',
    (value) => {
      expect(code(() => toSafeInteger(value, 'balance_credits', { allowNegative: true }))).toBe(
        'INTEGER_INVALID',
      );
    },
  );

  it('names the field and never the value', () => {
    const error = thrown(() => toSafeInteger('123456789.987654321', 'amount_cents'));
    expect(error).toBeInstanceOf(DbError);
    const text = errorText(error);
    expect((error as DbError).message).toContain('amount_cents');
    expect(text).not.toContain('123456789.987654321');
    expect(text).not.toContain('987654321');
  });
});
