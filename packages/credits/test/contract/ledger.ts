import { describe, expect, it } from 'vitest';
import {
  ENTRY_KINDS,
  SPEND_REASONS,
  credits,
  type CreditEntry,
  type CreditEntryId,
  type CreditLedger,
} from '../../src/index.ts';
import { ORG_A, SAFE_MAX, expectRejects, sumOf, type LedgerFactory } from '../support.ts';

export function ledgerContract(makeLedger: LedgerFactory): void {
  // Written out here so the test does not take its cases from the code under test.
  const AI_REASONS = ['generation', 'translation_draft', 'incident_draft'] as const;

  const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  async function funded(amount: number): Promise<CreditLedger> {
    const ledger = await makeLedger();
    await ledger.grant(ORG_A, { idempotencyKey: 'seed', amount: credits(amount) });
    return ledger;
  }

  async function spendOf(ledger: CreditLedger, key: string, amount: number): Promise<CreditEntry> {
    const outcome = await ledger.spend(ORG_A, {
      idempotencyKey: key,
      amount: credits(amount),
      reason: 'generation',
    });
    if (outcome.status !== 'applied') throw new Error(`spend ${key} was refused`);
    return outcome.entry;
  }

  describe('constants', () => {
    it('has exactly four entry kinds, frozen', () => {
      expect([...ENTRY_KINDS]).toEqual(['grant', 'spend', 'reversal', 'expiry']);
      expect(Object.isFrozen(ENTRY_KINDS)).toBe(true);
    });

    it('spends on AI work only: generation, translation drafts and incident drafts', () => {
      expect([...SPEND_REASONS]).toEqual([...AI_REASONS]);
      expect(Object.isFrozen(SPEND_REASONS)).toBe(true);
      for (const send of ['sms', 'voice', 'email', 'send']) {
        expect(SPEND_REASONS as readonly string[]).not.toContain(send);
      }
    });
  });

  describe('a new organization', () => {
    it('starts at zero with no entries', async () => {
      const ledger = await makeLedger();
      expect(await ledger.balance(ORG_A)).toBe(0);
      expect(await ledger.entries(ORG_A)).toEqual([]);
    });
  });

  describe('grant', () => {
    it('adds credits and records one grant entry', async () => {
      const ledger = await makeLedger();
      const outcome = await ledger.grant(ORG_A, { idempotencyKey: 'g1', amount: credits(100) });
      expect(outcome.status).toBe('applied');
      expect(outcome.entry).toEqual({
        id: outcome.entry.id,
        organizationId: ORG_A.organizationId,
        kind: 'grant',
        amount: 100,
        idempotencyKey: 'g1',
      });
      expect(outcome.entry.id).toMatch(CANONICAL_UUID);
      expect(await ledger.balance(ORG_A)).toBe(100);
      expect(await ledger.entries(ORG_A)).toEqual([outcome.entry]);
    });

    it('accepts a grant up to the largest safe integer', async () => {
      const ledger = await makeLedger();
      await ledger.grant(ORG_A, { idempotencyKey: 'g1', amount: credits(SAFE_MAX) });
      expect(await ledger.balance(ORG_A)).toBe(SAFE_MAX);
    });

    it('refuses a grant that would take the balance past the safe range and records nothing', async () => {
      const ledger = await funded(SAFE_MAX);
      await expectRejects(
        () => ledger.grant(ORG_A, { idempotencyKey: 'g2', amount: credits(1) }),
        'CREDIT_BALANCE_OVERFLOW',
      );
      expect(await ledger.balance(ORG_A)).toBe(SAFE_MAX);
      expect(await ledger.entries(ORG_A)).toHaveLength(1);
    });

    it('keeps the key of an overflowing grant free for a later retry', async () => {
      const ledger = await funded(SAFE_MAX);
      await expectRejects(
        () => ledger.grant(ORG_A, { idempotencyKey: 'g2', amount: credits(5) }),
        'CREDIT_BALANCE_OVERFLOW',
      );
      await spendOf(ledger, 's1', 5);
      const retry = await ledger.grant(ORG_A, { idempotencyKey: 'g2', amount: credits(5) });
      expect(retry.entry.amount).toBe(5);
      expect(await ledger.balance(ORG_A)).toBe(SAFE_MAX);
    });
  });

  describe('spend', () => {
    it.each(AI_REASONS)('spends for %s and records the reason', async (reason) => {
      const ledger = await funded(10);
      const outcome = await ledger.spend(ORG_A, {
        idempotencyKey: 's1',
        amount: credits(4),
        reason,
      });
      expect(outcome.status).toBe('applied');
      if (outcome.status !== 'applied') return;
      expect(outcome.entry).toEqual({
        id: outcome.entry.id,
        organizationId: ORG_A.organizationId,
        kind: 'spend',
        amount: 4,
        idempotencyKey: 's1',
        reason,
      });
      expect(await ledger.balance(ORG_A)).toBe(6);
    });

    it('may spend the balance down to exactly zero', async () => {
      const ledger = await funded(10);
      await spendOf(ledger, 's1', 10);
      expect(await ledger.balance(ORG_A)).toBe(0);
    });

    it('is all or nothing: one credit too many is refused and records nothing', async () => {
      const ledger = await funded(10);
      const before = await ledger.entries(ORG_A);
      const outcome = await ledger.spend(ORG_A, {
        idempotencyKey: 's1',
        amount: credits(11),
        reason: 'generation',
      });
      expect(outcome).toEqual({ status: 'insufficient', requested: 11, available: 10 });
      expect(await ledger.balance(ORG_A)).toBe(10);
      expect(await ledger.entries(ORG_A)).toEqual(before);
    });

    it('refuses any spend on an empty pool', async () => {
      const ledger = await makeLedger();
      const outcome = await ledger.spend(ORG_A, {
        idempotencyKey: 's1',
        amount: credits(1),
        reason: 'incident_draft',
      });
      expect(outcome).toEqual({ status: 'insufficient', requested: 1, available: 0 });
      expect(await ledger.entries(ORG_A)).toEqual([]);
    });

    it('refuses the largest safe spend against a balance one short', async () => {
      const ledger = await funded(SAFE_MAX - 1);
      const outcome = await ledger.spend(ORG_A, {
        idempotencyKey: 's1',
        amount: credits(SAFE_MAX),
        reason: 'generation',
      });
      expect(outcome.status).toBe('insufficient');
      expect(await ledger.balance(ORG_A)).toBe(SAFE_MAX - 1);
    });

    it.each([
      ['sms', 'sms'],
      ['voice', 'voice'],
      ['email', 'email'],
      ['an empty string', ''],
      ['uppercase', 'GENERATION'],
      ['a prototype key', '__proto__'],
      ['an inherited method name', 'toString'],
      ['a constructor name', 'constructor'],
      ['missing', undefined],
      ['a number', 1],
      ['a boxed string', new String('generation')],
    ])(
      'rejects the reason %s with CREDIT_REASON_INVALID and records nothing',
      async (_label, reason) => {
        const ledger = await funded(10);
        await expectRejects(
          () =>
            ledger.spend(ORG_A, {
              idempotencyKey: 's1',
              amount: credits(1),
              reason: reason as never,
            }),
          'CREDIT_REASON_INVALID',
        );
        expect(await ledger.balance(ORG_A)).toBe(10);
      },
    );
  });

  describe('expiry', () => {
    it('removes credits and records an expiry entry', async () => {
      const ledger = await funded(10);
      const outcome = await ledger.expire(ORG_A, { idempotencyKey: 'e1', amount: credits(3) });
      expect(outcome.status).toBe('applied');
      if (outcome.status !== 'applied') return;
      expect(outcome.entry).toEqual({
        id: outcome.entry.id,
        organizationId: ORG_A.organizationId,
        kind: 'expiry',
        amount: 3,
        idempotencyKey: 'e1',
      });
      expect(await ledger.balance(ORG_A)).toBe(7);
    });

    it('never takes the balance below zero: more than the balance is refused whole', async () => {
      const ledger = await funded(10);
      await spendOf(ledger, 's1', 8);
      const outcome = await ledger.expire(ORG_A, { idempotencyKey: 'e1', amount: credits(3) });
      expect(outcome).toEqual({ status: 'insufficient', requested: 3, available: 2 });
      expect(await ledger.balance(ORG_A)).toBe(2);
      expect(await ledger.entries(ORG_A)).toHaveLength(2);
    });
  });

  describe('reversal', () => {
    it('returns a spend in full and points at it', async () => {
      const ledger = await funded(10);
      const spend = await spendOf(ledger, 's1', 4);
      const outcome = await ledger.reverse(ORG_A, { idempotencyKey: 'r1', entryId: spend.id });
      expect(outcome.status).toBe('applied');
      expect(outcome.entry).toEqual({
        id: outcome.entry.id,
        organizationId: ORG_A.organizationId,
        kind: 'reversal',
        amount: 4,
        idempotencyKey: 'r1',
        reverses: spend.id,
      });
      expect(await ledger.balance(ORG_A)).toBe(10);
    });

    it('refuses a second reversal of the same spend under a new key', async () => {
      const ledger = await funded(10);
      const spend = await spendOf(ledger, 's1', 4);
      await ledger.reverse(ORG_A, { idempotencyKey: 'r1', entryId: spend.id });
      await expectRejects(
        () => ledger.reverse(ORG_A, { idempotencyKey: 'r2', entryId: spend.id }),
        'CREDIT_NOT_REVERSIBLE',
      );
      expect(await ledger.balance(ORG_A)).toBe(10);
      expect(await ledger.entries(ORG_A)).toHaveLength(3);
    });

    it('refuses to reverse anything that is not a spend', async () => {
      const ledger = await funded(10);
      const [grant] = await ledger.entries(ORG_A);
      const spend = await spendOf(ledger, 's1', 4);
      const reversal = await ledger.reverse(ORG_A, { idempotencyKey: 'r1', entryId: spend.id });
      const expiry = await ledger.expire(ORG_A, { idempotencyKey: 'e1', amount: credits(1) });
      if (grant === undefined || expiry.status !== 'applied') throw new Error('setup failed');
      for (const target of [grant.id, reversal.entry.id, expiry.entry.id]) {
        await expectRejects(
          () => ledger.reverse(ORG_A, { idempotencyKey: `r-${target}`, entryId: target }),
          'CREDIT_NOT_REVERSIBLE',
        );
      }
      expect(await ledger.balance(ORG_A)).toBe(9);
    });

    it.each([
      ['an unknown UUID', '00000000-0000-0000-0000-000000000000'],
      ['an uppercase UUID', '01928C3E-7A9B-7C3D-8E4F-0123456789AB'],
      ['a public id', 'crd_01arz3ndektsv4rrffq69g5fav'],
      ['an empty string', ''],
      ['a number', 1],
      ['null', null],
      ['missing', undefined],
    ])('refuses %s as a target with CREDIT_ENTRY_NOT_FOUND', async (_label, entryId) => {
      const ledger = await funded(10);
      await expectRejects(
        () => ledger.reverse(ORG_A, { idempotencyKey: 'r1', entryId: entryId as CreditEntryId }),
        'CREDIT_ENTRY_NOT_FOUND',
      );
      expect(await ledger.balance(ORG_A)).toBe(10);
    });

    it('refuses a reversal that would take the balance past the safe range', async () => {
      const ledger = await funded(SAFE_MAX);
      const spend = await spendOf(ledger, 's1', 5);
      await ledger.grant(ORG_A, { idempotencyKey: 'g2', amount: credits(5) });
      await expectRejects(
        () => ledger.reverse(ORG_A, { idempotencyKey: 'r1', entryId: spend.id }),
        'CREDIT_BALANCE_OVERFLOW',
      );
      expect(await ledger.balance(ORG_A)).toBe(SAFE_MAX);
    });
  });

  describe('the ledger is append only', () => {
    it('returns frozen entries and a frozen list that cannot rewrite history', async () => {
      const ledger = await funded(10);
      await spendOf(ledger, 's1', 3);
      const entries = await ledger.entries(ORG_A);
      expect(Object.isFrozen(entries)).toBe(true);
      for (const entry of entries) expect(Object.isFrozen(entry)).toBe(true);
      expect(() => {
        (entries as CreditEntry[]).pop();
      }).toThrow(TypeError);
      expect(() => {
        (entries[0] as { amount: number }).amount = 1_000_000;
      }).toThrow(TypeError);
      expect(await ledger.balance(ORG_A)).toBe(7);
      expect(await ledger.entries(ORG_A)).toHaveLength(2);
    });

    it('returns frozen outcomes', async () => {
      const ledger = await makeLedger();
      const granted = await ledger.grant(ORG_A, { idempotencyKey: 'g1', amount: credits(1) });
      const refused = await ledger.spend(ORG_A, {
        idempotencyKey: 's1',
        amount: credits(2),
        reason: 'generation',
      });
      expect(Object.isFrozen(granted)).toBe(true);
      expect(Object.isFrozen(refused)).toBe(true);
    });

    it('keeps entries in the order they were applied, and a reversal never edits its spend', async () => {
      const ledger = await funded(10);
      const spend = await spendOf(ledger, 's1', 3);
      await ledger.reverse(ORG_A, { idempotencyKey: 'r1', entryId: spend.id });
      await ledger.expire(ORG_A, { idempotencyKey: 'e1', amount: credits(2) });
      const entries = await ledger.entries(ORG_A);
      expect(entries.map((entry) => entry.kind)).toEqual(['grant', 'spend', 'reversal', 'expiry']);
      expect(entries[1]).toEqual(spend);
      expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
      expect(await ledger.balance(ORG_A)).toBe(sumOf(entries));
    });

    it('does not keep a reference to the caller request', async () => {
      const ledger = await makeLedger();
      const request = { idempotencyKey: 'g1', amount: credits(5) };
      await ledger.grant(ORG_A, request);
      (request as { amount: number }).amount = 500;
      request.idempotencyKey = 'other';
      const [entry] = await ledger.entries(ORG_A);
      expect(entry?.amount).toBe(5);
      expect(entry?.idempotencyKey).toBe('g1');
    });

    it('gives each entry kind exactly its own fields', async () => {
      const ledger = await funded(10);
      const spend = await spendOf(ledger, 's1', 3);
      await ledger.reverse(ORG_A, { idempotencyKey: 'r1', entryId: spend.id });
      await ledger.expire(ORG_A, { idempotencyKey: 'e1', amount: credits(1) });
      const base = ['amount', 'id', 'idempotencyKey', 'kind', 'organizationId'];
      const fields = (await ledger.entries(ORG_A)).map((entry) => Object.keys(entry).sort());
      expect(fields).toEqual([
        base,
        [...base, 'reason'].sort(),
        [...base, 'reverses'].sort(),
        base,
      ]);
    });
  });
}
