import { describe, expect, it } from 'vitest';
import {
  credits,
  type CreditEntry,
  type CreditEntryId,
  type CreditLedger,
} from '../../src/index.ts';
import {
  ORG_A,
  ORG_B,
  SAFE_MAX,
  asyncCodeOf,
  expectRejects,
  sumOf,
  type LedgerFactory,
} from '../support.ts';

export function settlementContract(makeLedger: LedgerFactory): void {
  async function funded(amount: number): Promise<CreditLedger> {
    const ledger = await makeLedger();
    await ledger.grant(ORG_A, { idempotencyKey: 'seed', amount: credits(amount) });
    return ledger;
  }

  async function spendOf(ledger: CreditLedger, key: string, amount: number): Promise<CreditEntry> {
    const outcome = await ledger.spend(ORG_A, {
      idempotencyKey: key,
      amount: credits(amount),
      reason: 'reader_answer',
    });
    if (outcome.status !== 'applied') throw new Error(`spend ${key} was refused`);
    return outcome.entry;
  }

  describe('settlement', () => {
    it('returns exactly the amount once, points at the spend and raises the balance by it', async () => {
      const ledger = await funded(10);
      const spend = await spendOf(ledger, 's1', 6);
      const outcome = await ledger.settle(ORG_A, {
        idempotencyKey: 'st1',
        entryId: spend.id,
        amount: credits(4),
      });
      expect(outcome.status).toBe('applied');
      expect(outcome.entry).toEqual({
        id: outcome.entry.id,
        organizationId: ORG_A.organizationId,
        kind: 'settlement',
        amount: 4,
        idempotencyKey: 'st1',
        settles: spend.id,
      });
      expect(Object.isFrozen(outcome)).toBe(true);
      expect(Object.isFrozen(outcome.entry)).toBe(true);
      expect(await ledger.balance(ORG_A)).toBe(8);
      const entries = await ledger.entries(ORG_A);
      expect(entries.map((entry) => entry.kind)).toEqual(['grant', 'spend', 'settlement']);
      expect(entries[1]).toEqual(spend);
      expect(await ledger.balance(ORG_A)).toBe(sumOf(entries));
    });

    it('returns as little as one credit, and as much as one less than the spend', async () => {
      const ledger = await funded(20);
      const small = await spendOf(ledger, 's1', 5);
      const large = await spendOf(ledger, 's2', 5);
      await ledger.settle(ORG_A, { idempotencyKey: 'st1', entryId: small.id, amount: credits(1) });
      await ledger.settle(ORG_A, { idempotencyKey: 'st2', entryId: large.id, amount: credits(4) });
      expect(await ledger.balance(ORG_A)).toBe(15);
    });

    it('never needs balance: it settles a spend that took the pool to zero', async () => {
      const ledger = await funded(7);
      const spend = await spendOf(ledger, 's1', 7);
      expect(await ledger.balance(ORG_A)).toBe(0);
      await ledger.settle(ORG_A, { idempotencyKey: 'st1', entryId: spend.id, amount: credits(5) });
      expect(await ledger.balance(ORG_A)).toBe(5);
    });

    it.each([
      ['the whole spend', 6],
      ['more than the spend', 7],
      ['far more than the spend', SAFE_MAX],
    ])(
      'refuses %s with CREDIT_AMOUNT_INVALID, writes nothing and leaves the key free',
      async (_label, amount) => {
        const ledger = await funded(10);
        const spend = await spendOf(ledger, 's1', 6);
        const before = await ledger.entries(ORG_A);
        await expectRejects(
          () =>
            ledger.settle(ORG_A, {
              idempotencyKey: 'st1',
              entryId: spend.id,
              amount: credits(amount),
            }),
          'CREDIT_AMOUNT_INVALID',
        );
        expect(await ledger.entries(ORG_A)).toEqual(before);
        expect(await ledger.balance(ORG_A)).toBe(4);
        const retry = await ledger.settle(ORG_A, {
          idempotencyKey: 'st1',
          entryId: spend.id,
          amount: credits(2),
        });
        expect(retry.entry.amount).toBe(2);
        expect(await ledger.balance(ORG_A)).toBe(6);
      },
    );

    it.each([
      ['zero', 0],
      ['negative', -1],
      ['fractional', 1.5],
      ['NaN', Number.NaN],
      ['unsafe', SAFE_MAX + 1],
      ['a string', '2'],
      ['missing', undefined],
    ])('refuses a %s amount with CREDIT_AMOUNT_INVALID', async (_label, amount) => {
      const ledger = await funded(10);
      const spend = await spendOf(ledger, 's1', 6);
      await expectRejects(
        () =>
          ledger.settle(ORG_A, {
            idempotencyKey: 'st1',
            entryId: spend.id,
            amount: amount as never,
          }),
        'CREDIT_AMOUNT_INVALID',
      );
      expect(await ledger.entries(ORG_A)).toHaveLength(2);
    });

    it('refuses a bad key with CREDIT_KEY_INVALID before looking at the amount', async () => {
      const ledger = await funded(10);
      const spend = await spendOf(ledger, 's1', 6);
      await expectRejects(
        () => ledger.settle(ORG_A, { idempotencyKey: '', entryId: spend.id, amount: 0 as never }),
        'CREDIT_KEY_INVALID',
      );
    });

    it('refuses a bad organization ref with CREDIT_ORGANIZATION_INVALID', async () => {
      const ledger = await funded(10);
      const spend = await spendOf(ledger, 's1', 6);
      await expectRejects(
        () =>
          ledger.settle({ organizationId: 'nope' } as never, {
            idempotencyKey: 'st1',
            entryId: spend.id,
            amount: credits(1),
          }),
        'CREDIT_ORGANIZATION_INVALID',
      );
    });

    it('refuses a second settle of the same spend under a new key', async () => {
      const ledger = await funded(10);
      const spend = await spendOf(ledger, 's1', 6);
      await ledger.settle(ORG_A, { idempotencyKey: 'st1', entryId: spend.id, amount: credits(2) });
      await expectRejects(
        () =>
          ledger.settle(ORG_A, { idempotencyKey: 'st2', entryId: spend.id, amount: credits(1) }),
        'CREDIT_NOT_REVERSIBLE',
      );
      expect(await ledger.balance(ORG_A)).toBe(6);
      expect(await ledger.entries(ORG_A)).toHaveLength(3);
    });

    it('refuses to settle a reversed spend', async () => {
      const ledger = await funded(10);
      const spend = await spendOf(ledger, 's1', 6);
      await ledger.reverse(ORG_A, { idempotencyKey: 'r1', entryId: spend.id });
      await expectRejects(
        () =>
          ledger.settle(ORG_A, { idempotencyKey: 'st1', entryId: spend.id, amount: credits(2) }),
        'CREDIT_NOT_REVERSIBLE',
      );
      expect(await ledger.balance(ORG_A)).toBe(10);
      expect(await ledger.entries(ORG_A)).toHaveLength(3);
    });

    it('refuses to reverse a settled spend', async () => {
      const ledger = await funded(10);
      const spend = await spendOf(ledger, 's1', 6);
      await ledger.settle(ORG_A, { idempotencyKey: 'st1', entryId: spend.id, amount: credits(2) });
      await expectRejects(
        () => ledger.reverse(ORG_A, { idempotencyKey: 'r1', entryId: spend.id }),
        'CREDIT_NOT_REVERSIBLE',
      );
      expect(await ledger.balance(ORG_A)).toBe(6);
      expect(await ledger.entries(ORG_A)).toHaveLength(3);
    });

    it('refuses to settle anything that is not a spend', async () => {
      const ledger = await funded(10);
      const [grant] = await ledger.entries(ORG_A);
      const spend = await spendOf(ledger, 's1', 4);
      const settled = await spendOf(ledger, 's2', 4);
      const reversal = await ledger.reverse(ORG_A, { idempotencyKey: 'r1', entryId: spend.id });
      const settlement = await ledger.settle(ORG_A, {
        idempotencyKey: 'st0',
        entryId: settled.id,
        amount: credits(1),
      });
      const expiry = await ledger.expire(ORG_A, { idempotencyKey: 'e1', amount: credits(1) });
      if (grant === undefined || expiry.status !== 'applied') throw new Error('setup failed');
      const targets = [grant.id, reversal.entry.id, settlement.entry.id, expiry.entry.id];
      for (const target of targets) {
        await expectRejects(
          () =>
            ledger.settle(ORG_A, {
              idempotencyKey: `st-${target}`,
              entryId: target,
              amount: credits(1),
            }),
          'CREDIT_NOT_REVERSIBLE',
        );
        await expectRejects(
          () => ledger.reverse(ORG_A, { idempotencyKey: `r-${target}`, entryId: target }),
          'CREDIT_NOT_REVERSIBLE',
        );
      }
      expect(await ledger.balance(ORG_A)).toBe(6);
    });

    it.each([
      ['an unknown UUID', '00000000-0000-0000-0000-000000000000'],
      ['a public id', 'crd_01arz3ndektsv4rrffq69g5fav'],
      ['an empty string', ''],
      ['null', null],
      ['missing', undefined],
    ])('refuses %s as a target with CREDIT_ENTRY_NOT_FOUND', async (_label, entryId) => {
      const ledger = await funded(10);
      await expectRejects(
        () =>
          ledger.settle(ORG_A, {
            idempotencyKey: 'st1',
            entryId: entryId as CreditEntryId,
            amount: credits(1),
          }),
        'CREDIT_ENTRY_NOT_FOUND',
      );
      expect(await ledger.balance(ORG_A)).toBe(10);
    });

    it("cannot settle another organization's spend, and learns nothing about it", async () => {
      const ledger = await funded(10);
      const spend = await spendOf(ledger, 's1', 6);
      await ledger.grant(ORG_B, { idempotencyKey: 'seed', amount: credits(10) });
      await expectRejects(
        () =>
          ledger.settle(ORG_B, { idempotencyKey: 'st1', entryId: spend.id, amount: credits(2) }),
        'CREDIT_ENTRY_NOT_FOUND',
      );
      expect(await ledger.balance(ORG_B)).toBe(10);
      await ledger.settle(ORG_A, { idempotencyKey: 'st1', entryId: spend.id, amount: credits(2) });
      expect(await ledger.balance(ORG_A)).toBe(6);
    });

    it('refuses a settlement that would take the balance past the safe range', async () => {
      const ledger = await funded(SAFE_MAX);
      const spend = await spendOf(ledger, 's1', 5);
      await ledger.grant(ORG_A, { idempotencyKey: 'g2', amount: credits(5) });
      await expectRejects(
        () =>
          ledger.settle(ORG_A, { idempotencyKey: 'st1', entryId: spend.id, amount: credits(2) }),
        'CREDIT_BALANCE_OVERFLOW',
      );
      expect(await ledger.balance(ORG_A)).toBe(SAFE_MAX);
      await ledger.expire(ORG_A, { idempotencyKey: 'e1', amount: credits(2) });
      await ledger.settle(ORG_A, { idempotencyKey: 'st1', entryId: spend.id, amount: credits(2) });
      expect(await ledger.balance(ORG_A)).toBe(SAFE_MAX);
    });
  });

  describe('settlement idempotency', () => {
    it('replaying the same key and request returns the original entry and changes nothing', async () => {
      const ledger = await funded(10);
      const spend = await spendOf(ledger, 's1', 6);
      const request = { idempotencyKey: 'st1', entryId: spend.id, amount: credits(4) };
      const first = await ledger.settle(ORG_A, request);
      const again = await ledger.settle(ORG_A, { ...request });
      expect(again).toEqual(first);
      expect(again.entry.id).toBe(first.entry.id);
      expect(await ledger.balance(ORG_A)).toBe(8);
      expect(await ledger.entries(ORG_A)).toHaveLength(3);
    });

    it('replays even after the spend can no longer be settled or reversed', async () => {
      const ledger = await funded(10);
      const spend = await spendOf(ledger, 's1', 6);
      const first = await ledger.settle(ORG_A, {
        idempotencyKey: 'st1',
        entryId: spend.id,
        amount: credits(4),
      });
      await expectRejects(
        () => ledger.reverse(ORG_A, { idempotencyKey: 'r1', entryId: spend.id }),
        'CREDIT_NOT_REVERSIBLE',
      );
      const again = await ledger.settle(ORG_A, {
        idempotencyKey: 'st1',
        entryId: spend.id,
        amount: credits(4),
      });
      expect(again).toEqual(first);
    });

    it.each([
      ['a different amount', { amount: 3 }],
      ['a different spend', { other: true }],
    ])('a key reused with %s is a conflict that changes nothing', async (_label, change) => {
      const ledger = await funded(20);
      const spend = await spendOf(ledger, 's1', 6);
      const other = await spendOf(ledger, 's2', 6);
      await ledger.settle(ORG_A, { idempotencyKey: 'st1', entryId: spend.id, amount: credits(4) });
      const before = await ledger.entries(ORG_A);
      await expectRejects(
        () =>
          ledger.settle(ORG_A, {
            idempotencyKey: 'st1',
            entryId: 'other' in change ? other.id : spend.id,
            amount: credits('amount' in change ? change.amount : 4),
          }),
        'CREDIT_IDEMPOTENCY_CONFLICT',
      );
      expect(await ledger.entries(ORG_A)).toEqual(before);
    });

    it('shares the key space with every other kind', async () => {
      const ledger = await funded(10);
      const spend = await spendOf(ledger, 's1', 6);
      await expectRejects(
        () => ledger.settle(ORG_A, { idempotencyKey: 's1', entryId: spend.id, amount: credits(2) }),
        'CREDIT_IDEMPOTENCY_CONFLICT',
      );
      await ledger.settle(ORG_A, { idempotencyKey: 'st1', entryId: spend.id, amount: credits(2) });
      await expectRejects(
        () => ledger.grant(ORG_A, { idempotencyKey: 'st1', amount: credits(2) }),
        'CREDIT_IDEMPOTENCY_CONFLICT',
      );
      await expectRejects(
        () => ledger.reverse(ORG_A, { idempotencyKey: 'st1', entryId: spend.id }),
        'CREDIT_IDEMPOTENCY_CONFLICT',
      );
    });
  });

  describe('settlement under concurrency', () => {
    it('parallel settles of one spend under different keys return credits once', async () => {
      const ledger = await funded(10);
      const spend = await spendOf(ledger, 's1', 6);
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          asyncCodeOf(() =>
            ledger.settle(ORG_A, {
              idempotencyKey: `st${i}`,
              entryId: spend.id,
              amount: credits(1 + (i % 5)),
            }),
          ),
        ),
      );
      expect(results.filter((r) => r === 'no error')).toHaveLength(1);
      expect(results.filter((r) => r === 'CREDIT_NOT_REVERSIBLE')).toHaveLength(9);
      const entries = await ledger.entries(ORG_A);
      expect(entries.filter((entry) => entry.kind === 'settlement')).toHaveLength(1);
      expect(await ledger.balance(ORG_A)).toBe(sumOf(entries));
    });

    it('a settle racing a reversal of the same spend: exactly one wins', async () => {
      const ledger = await funded(10);
      const spend = await spendOf(ledger, 's1', 6);
      const results = await Promise.all([
        asyncCodeOf(() =>
          ledger.settle(ORG_A, { idempotencyKey: 'st1', entryId: spend.id, amount: credits(2) }),
        ),
        asyncCodeOf(() => ledger.reverse(ORG_A, { idempotencyKey: 'r1', entryId: spend.id })),
      ]);
      expect(results.filter((r) => r === 'no error')).toHaveLength(1);
      expect(results.filter((r) => r === 'CREDIT_NOT_REVERSIBLE')).toHaveLength(1);
      const balance = await ledger.balance(ORG_A);
      expect([6, 10]).toContain(balance);
      expect(balance).toBe(sumOf(await ledger.entries(ORG_A)));
    });

    it('parallel retries of one settle give one entry and the same outcome', async () => {
      const ledger = await funded(10);
      const spend = await spendOf(ledger, 's1', 6);
      const outcomes = await Promise.all(
        Array.from({ length: 10 }, () =>
          ledger.settle(ORG_A, { idempotencyKey: 'st1', entryId: spend.id, amount: credits(3) }),
        ),
      );
      for (const outcome of outcomes) expect(outcome).toEqual(outcomes[0]);
      expect(await ledger.balance(ORG_A)).toBe(7);
    });
  });
}
