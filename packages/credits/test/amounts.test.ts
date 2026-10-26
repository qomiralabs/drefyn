import { describe, expect, it } from 'vitest';
import { CreditError, credits } from '../src/index.ts';
import { NOT_CREDITS } from './contract/amounts.ts';
import { ERROR_CODES, SAFE_MAX, expectCode } from './support.ts';

describe('credits()', () => {
  it.each([0, 1, 2, 999, 1_000_000, 2 ** 31, 2 ** 32 + 1, SAFE_MAX - 1, SAFE_MAX])(
    'accepts the non negative safe integer %s unchanged',
    (value) => {
      expect(credits(value)).toBe(value);
    },
  );

  it('turns -0 into 0 so a zero balance has one spelling', () => {
    expect(Object.is(credits(-0), 0)).toBe(true);
  });

  it.each(NOT_CREDITS)('rejects %s with CREDIT_AMOUNT_INVALID', (_label, value) => {
    expectCode(() => credits(value), 'CREDIT_AMOUNT_INVALID');
  });

  it('never puts the rejected value in the message', () => {
    const marker = 987654321.123;
    try {
      credits(marker);
      expect.unreachable('credits accepted a fraction');
    } catch (error) {
      expect(error).toBeInstanceOf(CreditError);
      expect((error as CreditError).message).not.toContain('987654321');
    }
  });

  it('throws an Error subclass named CreditError with a stable code', () => {
    try {
      credits(Number.NaN);
      expect.unreachable('credits accepted NaN');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(CreditError);
      expect((error as CreditError).name).toBe('CreditError');
      expect((error as CreditError).code).toBe('CREDIT_AMOUNT_INVALID');
      expect((error as CreditError).message.length).toBeGreaterThan(0);
    }
  });

  it('gives each stable code its own fixed, non empty message', () => {
    const messages = ERROR_CODES.map((code) => new CreditError(code).message);
    for (const message of messages) expect(message.length).toBeGreaterThan(0);
    expect(new Set(messages).size).toBe(ERROR_CODES.length);
    for (const code of ERROR_CODES) expect(new CreditError(code).code).toBe(code);
  });
});
