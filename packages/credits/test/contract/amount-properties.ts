import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { credits } from '../../src/index.ts';
import { ORG_A, SAFE_MAX, asyncCodeOf, runs, type LedgerFactory } from '../support.ts';

const isCreditValue = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

// Doubles of every kind: fractions, huge values, subnormals, infinities and NaN.
export const notCredits = fc
  .oneof(
    fc.double(),
    fc.double({ min: SAFE_MAX, max: Number.MAX_VALUE, noNaN: true }),
    fc.integer({ min: Number.MIN_SAFE_INTEGER, max: -1 }),
    fc.double({ min: -1, max: 1, noNaN: true }),
  )
  .filter((value) => !isCreditValue(value));

export const notNumbers = fc.oneof(
  fc.bigInt(),
  fc.string(),
  fc.boolean(),
  fc.constantFrom(null, undefined),
  fc.nat().map((n) => new Number(n)),
  fc.nat().map((n) => [n]),
  fc.nat().map((n) => String(n)),
);

export function amountPropertiesContract(makeLedger: LedgerFactory): void {
  describe('amount properties', () => {
    it('records nothing for any rejected amount on any entry kind', async () => {
      await fc.assert(
        fc.asyncProperty(fc.oneof(notCredits, notNumbers, fc.constant(0)), async (value) => {
          const ledger = await makeLedger();
          await ledger.grant(ORG_A, { idempotencyKey: 'seed', amount: credits(50) });
          const amount = value as never;
          const codes = await Promise.all([
            asyncCodeOf(() => ledger.grant(ORG_A, { idempotencyKey: 'g', amount })),
            asyncCodeOf(() =>
              ledger.spend(ORG_A, { idempotencyKey: 's', amount, reason: 'generation' }),
            ),
            asyncCodeOf(() => ledger.expire(ORG_A, { idempotencyKey: 'e', amount })),
          ]);
          expect(codes).toEqual([
            'CREDIT_AMOUNT_INVALID',
            'CREDIT_AMOUNT_INVALID',
            'CREDIT_AMOUNT_INVALID',
          ]);
          expect(await ledger.balance(ORG_A)).toBe(50);
          expect(await ledger.entries(ORG_A)).toHaveLength(1);
        }),
        runs,
      );
    });
  });
}
