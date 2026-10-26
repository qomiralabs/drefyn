import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { credits } from '../src/index.ts';
import { notCredits, notNumbers } from './contract/amount-properties.ts';
import { SAFE_MAX, codeOf, runs } from './support.ts';

describe('amount properties', () => {
  it('accepts every non negative safe integer unchanged', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: SAFE_MAX }), (value) => {
        expect(credits(value)).toBe(value);
      }),
      runs,
    );
  });

  it('rejects every number that is not a non negative safe integer', () => {
    fc.assert(
      fc.property(notCredits, (value) => {
        expect(codeOf(() => credits(value))).toBe('CREDIT_AMOUNT_INVALID');
      }),
      runs,
    );
  });

  it('rejects every value that is not a number primitive', () => {
    fc.assert(
      fc.property(notNumbers, (value) => {
        expect(codeOf(() => credits(value))).toBe('CREDIT_AMOUNT_INVALID');
      }),
      runs,
    );
  });
});
