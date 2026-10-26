import { describe, expect, it } from 'vitest';
import { credits, type CreditLedger } from '../../src/index.ts';
import { ORG_A, expectRejects, snapshot, tenantOf, type LedgerFactory } from '../support.ts';

export function idempotencyContract(makeLedger: LedgerFactory): void {
  async function funded(amount: number): Promise<CreditLedger> {
    const ledger = await makeLedger();
    await ledger.grant(ORG_A, { idempotencyKey: 'seed', amount: credits(amount) });
    return ledger;
  }

  describe('a repeated key with the same request', () => {
    it('returns the original grant and adds nothing', async () => {
      const ledger = await makeLedger();
      const first = await ledger.grant(ORG_A, { idempotencyKey: 'g1', amount: credits(5) });
      const second = await ledger.grant(ORG_A, { idempotencyKey: 'g1', amount: credits(5) });
      expect(second).toEqual(first);
      expect(second.entry.id).toBe(first.entry.id);
      expect(await ledger.balance(ORG_A)).toBe(5);
      expect(await ledger.entries(ORG_A)).toHaveLength(1);
    });

    it('returns the original spend and charges nothing more, many times over', async () => {
      const ledger = await funded(10);
      const request = { idempotencyKey: 's1', amount: credits(3), reason: 'generation' } as const;
      const first = await ledger.spend(ORG_A, request);
      for (let i = 0; i < 25; i += 1)
        expect(await ledger.spend(ORG_A, { ...request })).toEqual(first);
      expect(await ledger.balance(ORG_A)).toBe(7);
      expect(await ledger.entries(ORG_A)).toHaveLength(2);
    });

    it('returns the original spend even after the balance can no longer cover it', async () => {
      const ledger = await funded(10);
      const request = { idempotencyKey: 's1', amount: credits(6), reason: 'generation' } as const;
      const first = await ledger.spend(ORG_A, request);
      await ledger.spend(ORG_A, { idempotencyKey: 's2', amount: credits(4), reason: 'generation' });
      expect(await ledger.balance(ORG_A)).toBe(0);
      expect(await ledger.spend(ORG_A, request)).toEqual(first);
      expect(await ledger.balance(ORG_A)).toBe(0);
    });

    it('returns the original spend after it was reversed, without charging again', async () => {
      const ledger = await funded(10);
      const request = { idempotencyKey: 's1', amount: credits(6), reason: 'generation' } as const;
      const first = await ledger.spend(ORG_A, request);
      if (first.status !== 'applied') throw new Error('setup failed');
      await ledger.reverse(ORG_A, { idempotencyKey: 'r1', entryId: first.entry.id });
      expect(await ledger.spend(ORG_A, request)).toEqual(first);
      expect(await ledger.balance(ORG_A)).toBe(10);
    });

    it('returns the original reversal instead of calling it already reversed', async () => {
      const ledger = await funded(10);
      const spend = await ledger.spend(ORG_A, {
        idempotencyKey: 's1',
        amount: credits(6),
        reason: 'generation',
      });
      if (spend.status !== 'applied') throw new Error('setup failed');
      const request = { idempotencyKey: 'r1', entryId: spend.entry.id };
      const first = await ledger.reverse(ORG_A, request);
      expect(await ledger.reverse(ORG_A, { ...request })).toEqual(first);
      expect(await ledger.balance(ORG_A)).toBe(10);
    });

    it('returns the original expiry', async () => {
      const ledger = await funded(10);
      const first = await ledger.expire(ORG_A, { idempotencyKey: 'e1', amount: credits(4) });
      const second = await ledger.expire(ORG_A, { idempotencyKey: 'e1', amount: credits(4) });
      expect(second).toEqual(first);
      expect(await ledger.balance(ORG_A)).toBe(6);
    });

    it('re-evaluates a refused spend, because a refusal records nothing', async () => {
      const ledger = await funded(2);
      const request = { idempotencyKey: 's1', amount: credits(5), reason: 'generation' } as const;
      expect((await ledger.spend(ORG_A, request)).status).toBe('insufficient');
      expect((await ledger.spend(ORG_A, request)).status).toBe('insufficient');
      await ledger.grant(ORG_A, { idempotencyKey: 'g2', amount: credits(3) });
      const retried = await ledger.spend(ORG_A, request);
      expect(retried.status).toBe('applied');
      expect(await ledger.balance(ORG_A)).toBe(0);
      expect(await ledger.spend(ORG_A, request)).toEqual(retried);
    });

    it('treats a TenantRef of the same organization as the same pool and the same key space', async () => {
      const ledger = await makeLedger();
      const tenant = tenantOf(ORG_A, '01928c3e-7a9b-7c3d-8e4f-0000000000aa');
      const first = await ledger.grant(ORG_A, { idempotencyKey: 'g1', amount: credits(5) });
      expect(await ledger.grant(tenant, { idempotencyKey: 'g1', amount: credits(5) })).toEqual(
        first,
      );
      expect(await ledger.balance(tenant)).toBe(5);
    });
  });

  describe('a repeated key with a different request', () => {
    async function withOriginals(): Promise<{ ledger: CreditLedger; spendId: string }> {
      const ledger = await funded(100);
      const spend = await ledger.spend(ORG_A, {
        idempotencyKey: 'spend',
        amount: credits(10),
        reason: 'generation',
      });
      const other = await ledger.spend(ORG_A, {
        idempotencyKey: 'other-spend',
        amount: credits(1),
        reason: 'generation',
      });
      if (spend.status !== 'applied' || other.status !== 'applied') throw new Error('setup failed');
      await ledger.grant(ORG_A, { idempotencyKey: 'grant', amount: credits(10) });
      await ledger.expire(ORG_A, { idempotencyKey: 'expiry', amount: credits(10) });
      await ledger.reverse(ORG_A, { idempotencyKey: 'reversal', entryId: spend.entry.id });
      return { ledger, spendId: other.entry.id };
    }

    const conflicts: readonly [
      string,
      (ledger: CreditLedger, otherSpendId: string) => Promise<unknown>,
    ][] = [
      [
        'grant with another amount',
        (l) => l.grant(ORG_A, { idempotencyKey: 'grant', amount: credits(11) }),
      ],
      [
        'spend with another amount',
        (l) =>
          l.spend(ORG_A, { idempotencyKey: 'spend', amount: credits(9), reason: 'generation' }),
      ],
      [
        'spend with another reason',
        (l) =>
          l.spend(ORG_A, {
            idempotencyKey: 'spend',
            amount: credits(10),
            reason: 'translation_draft',
          }),
      ],
      [
        'expiry with another amount',
        (l) => l.expire(ORG_A, { idempotencyKey: 'expiry', amount: credits(1) }),
      ],
      [
        'reversal of another spend',
        (l, other) => l.reverse(ORG_A, { idempotencyKey: 'reversal', entryId: other as never }),
      ],
      [
        'a grant key reused for a spend',
        (l) =>
          l.spend(ORG_A, { idempotencyKey: 'grant', amount: credits(10), reason: 'generation' }),
      ],
      [
        'a spend key reused for a grant',
        (l) => l.grant(ORG_A, { idempotencyKey: 'spend', amount: credits(10) }),
      ],
      [
        'a spend key reused for an expiry',
        (l) => l.expire(ORG_A, { idempotencyKey: 'spend', amount: credits(10) }),
      ],
      [
        'an expiry key reused for a grant',
        (l) => l.grant(ORG_A, { idempotencyKey: 'expiry', amount: credits(10) }),
      ],
      [
        'a grant key reused for a reversal',
        (l, other) => l.reverse(ORG_A, { idempotencyKey: 'grant', entryId: other as never }),
      ],
      [
        'a reversal key reused for a grant',
        (l) => l.grant(ORG_A, { idempotencyKey: 'reversal', amount: credits(10) }),
      ],
    ];

    it.each(conflicts)(
      '%s fails with CREDIT_IDEMPOTENCY_CONFLICT and changes nothing',
      async (_label, run) => {
        const { ledger, spendId } = await withOriginals();
        const before = await snapshot(ledger, ORG_A);
        await expectRejects(() => run(ledger, spendId), 'CREDIT_IDEMPOTENCY_CONFLICT');
        expect(await snapshot(ledger, ORG_A)).toEqual(before);
      },
    );

    it('checks the key before the balance, so an unaffordable conflicting spend is still a conflict', async () => {
      const ledger = await funded(10);
      await ledger.spend(ORG_A, { idempotencyKey: 's1', amount: credits(3), reason: 'generation' });
      await expectRejects(
        () =>
          ledger.spend(ORG_A, {
            idempotencyKey: 's1',
            amount: credits(1_000),
            reason: 'generation',
          }),
        'CREDIT_IDEMPOTENCY_CONFLICT',
      );
    });

    it('checks the key before overflow, so a conflicting grant is a conflict even when it would overflow', async () => {
      const ledger = await funded(Number.MAX_SAFE_INTEGER);
      await expectRejects(
        () => ledger.grant(ORG_A, { idempotencyKey: 'seed', amount: credits(1) }),
        'CREDIT_IDEMPOTENCY_CONFLICT',
      );
    });

    it('validates the request before looking up the key', async () => {
      const ledger = await funded(10);
      await expectRejects(
        () => ledger.grant(ORG_A, { idempotencyKey: 'seed', amount: 10.5 as never }),
        'CREDIT_AMOUNT_INVALID',
      );
    });
  });

  describe('idempotency keys', () => {
    it.each([
      ['one character', 'k'],
      ['200 ASCII characters', 'k'.repeat(200)],
      [
        '200 astral characters (400 UTF-16 units, 200 in Postgres length())',
        '\u{1F600}'.repeat(200),
      ],
      ['a UUID', '01928c3e-7a9b-7c3d-8e4f-0123456789ab'],
      ['spaces inside', 'job 42 attempt'],
    ])('accepts %s', async (_label, key) => {
      const ledger = await makeLedger();
      const outcome = await ledger.grant(ORG_A, { idempotencyKey: key, amount: credits(1) });
      expect(outcome.entry.idempotencyKey).toBe(key);
    });

    it.each([
      ['an empty string', ''],
      ['201 ASCII characters', 'k'.repeat(201)],
      ['201 astral characters', '\u{1F600}'.repeat(201)],
      ['a lone high surrogate', 'key\uD800'],
      ['a lone low surrogate', '\uDC00key'],
      ['a NUL character, which Postgres text cannot store', 'key\u0000'],
      ['a number', 42],
      ['a boxed string', new String('key')],
      ['null', null],
      ['missing', undefined],
      ['an array', ['key']],
    ])('rejects %s with CREDIT_KEY_INVALID and records nothing', async (_label, key) => {
      const ledger = await makeLedger();
      await expectRejects(
        () => ledger.grant(ORG_A, { idempotencyKey: key as never, amount: credits(1) }),
        'CREDIT_KEY_INVALID',
      );
      expect(await ledger.entries(ORG_A)).toEqual([]);
    });

    it('does not echo a rejected key in the error message', async () => {
      const ledger = await makeLedger();
      const key = 'secret-looking-key-'.repeat(20);
      try {
        await ledger.grant(ORG_A, { idempotencyKey: key, amount: credits(1) });
        expect.unreachable('a 380 character key was accepted');
      } catch (error) {
        expect((error as Error).message).not.toContain('secret-looking-key');
      }
    });

    it('compares keys exactly: no trimming, case folding or Unicode normalization', async () => {
      const ledger = await makeLedger();
      const keys = ['k', ' k', 'k ', 'K', 'é', 'é'];
      for (const key of keys)
        await ledger.grant(ORG_A, { idempotencyKey: key, amount: credits(1) });
      expect(await ledger.balance(ORG_A)).toBe(keys.length);
    });

    it('ignores a key inherited from the prototype', async () => {
      const ledger = await makeLedger();
      const request = Object.create({ idempotencyKey: 'k' }) as { amount: number };
      request.amount = credits(1);
      await expectRejects(() => ledger.grant(ORG_A, request as never), 'CREDIT_KEY_INVALID');
    });
  });
}
