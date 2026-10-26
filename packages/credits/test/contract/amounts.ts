import { describe, expect, it } from 'vitest';
import { credits } from '../../src/index.ts';
import { ORG_A, SAFE_MAX, expectRejects, type LedgerFactory } from '../support.ts';

// Values a JavaScript caller, a JSON body or a database driver could hand the ledger.
export const NOT_CREDITS: readonly [string, unknown][] = [
  ['a fraction', 1.5],
  ['a tiny fraction', 0.1 + 0.2],
  ['the smallest double', Number.MIN_VALUE],
  ['just under one', 1 - Number.EPSILON],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['minus Infinity', Number.NEGATIVE_INFINITY],
  ['minus one', -1],
  ['the most negative safe integer', Number.MIN_SAFE_INTEGER],
  ['a negative fraction', -0.5],
  ['one above the safe range', SAFE_MAX + 1],
  ['2 ** 53 + 2', 2 ** 53 + 2],
  ['1e21', 1e21],
  ['the largest double', Number.MAX_VALUE],
  ['a bigint', 1n],
  ['a large bigint', 2n ** 64n],
  ['a boxed number', new Number(5)],
  ['a numeric string', '5'],
  ['an empty string', ''],
  ['a hex string', '0x10'],
  ['true', true],
  ['null', null],
  ['undefined', undefined],
  ['an array of one number', [5]],
  ['an object with valueOf', { valueOf: () => 5 }],
  ['an object with toPrimitive', { [Symbol.toPrimitive]: () => 5 }],
  ['a symbol', Symbol('5')],
  ['a function', () => 5],
  ['a Date', new Date(5)],
];

export function entryAmountsContract(makeLedger: LedgerFactory): void {
  describe('entry amounts', () => {
    const ops = {
      grant: async (amount: unknown) =>
        (await makeLedger()).grant(ORG_A, { idempotencyKey: 'k', amount: amount as never }),
      spend: async (amount: unknown) => {
        const ledger = await makeLedger();
        await ledger.grant(ORG_A, { idempotencyKey: 'seed', amount: credits(SAFE_MAX) });
        return ledger.spend(ORG_A, {
          idempotencyKey: 'k',
          amount: amount as never,
          reason: 'generation',
        });
      },
      expire: async (amount: unknown) => {
        const ledger = await makeLedger();
        await ledger.grant(ORG_A, { idempotencyKey: 'seed', amount: credits(SAFE_MAX) });
        return ledger.expire(ORG_A, { idempotencyKey: 'k', amount: amount as never });
      },
    } as const;

    for (const [kind, run] of Object.entries(ops)) {
      it.each(NOT_CREDITS)(
        `${kind} rejects %s with CREDIT_AMOUNT_INVALID`,
        async (_label, value) => {
          await expectRejects(() => run(value), 'CREDIT_AMOUNT_INVALID');
        },
      );

      it(`${kind} rejects zero, since an entry that moves nothing is a caller bug`, async () => {
        await expectRejects(() => run(0), 'CREDIT_AMOUNT_INVALID');
        await expectRejects(() => run(-0), 'CREDIT_AMOUNT_INVALID');
      });
    }

    it('records nothing when an amount is rejected', async () => {
      const ledger = await makeLedger();
      await ledger.grant(ORG_A, { idempotencyKey: 'seed', amount: credits(10) });
      for (const [, value] of NOT_CREDITS) {
        await expectRejects(
          () =>
            ledger.spend(ORG_A, {
              idempotencyKey: 'x',
              amount: value as never,
              reason: 'generation',
            }),
          'CREDIT_AMOUNT_INVALID',
        );
        await expectRejects(
          () => ledger.grant(ORG_A, { idempotencyKey: 'y', amount: value as never }),
          'CREDIT_AMOUNT_INVALID',
        );
      }
      expect(await ledger.balance(ORG_A)).toBe(10);
      expect(await ledger.entries(ORG_A)).toHaveLength(1);
    });

    it('does not consume the key of a rejected request', async () => {
      const ledger = await makeLedger();
      await expectRejects(
        () => ledger.grant(ORG_A, { idempotencyKey: 'k', amount: 1.5 as never }),
        'CREDIT_AMOUNT_INVALID',
      );
      const outcome = await ledger.grant(ORG_A, { idempotencyKey: 'k', amount: credits(2) });
      expect(outcome.entry.amount).toBe(2);
      expect(await ledger.balance(ORG_A)).toBe(2);
    });

    it('reads an amount once, so a getter cannot pass validation and then change', async () => {
      const ledger = await makeLedger();
      let reads = 0;
      const request = {
        idempotencyKey: 'k',
        get amount(): never {
          reads += 1;
          return (reads === 1 ? 5 : Number.NaN) as never;
        },
      };
      const outcome = await ledger.grant(ORG_A, request);
      expect(outcome.entry.amount).toBe(5);
      expect(await ledger.balance(ORG_A)).toBe(5);
      expect(reads).toBe(1);
    });

    it('ignores an amount inherited from the prototype', async () => {
      const ledger = await makeLedger();
      const request = Object.create({ amount: credits(5) }) as { idempotencyKey: string };
      request.idempotencyKey = 'k';
      await expectRejects(() => ledger.grant(ORG_A, request as never), 'CREDIT_AMOUNT_INVALID');
      expect(await ledger.balance(ORG_A)).toBe(0);
    });

    // The key is checked before the body, so a request with no own key fails on the key.
    it.each([null, undefined, 5, 'k', [], new Map([['idempotencyKey', 'k']])])(
      'rejects the request %s with CREDIT_KEY_INVALID',
      async (request) => {
        const ledger = await makeLedger();
        await expectRejects(() => ledger.grant(ORG_A, request as never), 'CREDIT_KEY_INVALID');
        expect(await ledger.entries(ORG_A)).toEqual([]);
      },
    );
  });
}
