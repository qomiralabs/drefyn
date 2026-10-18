// Every ledger call is async because the Postgres store will be. A ledger that checks the
// balance in one step and appends in another passes every sequential test and fails these.
import { describe, expect, it } from 'vitest';
import { credits, type CreditLedger } from '../src/index.ts';
import { ORG_A, ORG_B, asyncCodeOf, newLedger, sumOf } from './support.ts';

async function funded(amount: number): Promise<CreditLedger> {
  const ledger = newLedger();
  await ledger.grant(ORG_A, { idempotencyKey: 'seed', amount: credits(amount) });
  return ledger;
}

describe('concurrent calls', () => {
  it('twenty parallel spends of one credit against ten credits: exactly ten apply', async () => {
    const ledger = await funded(10);
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        ledger.spend(ORG_A, { idempotencyKey: `s${i}`, amount: credits(1), reason: 'generation' }),
      ),
    );
    expect(outcomes.filter((o) => o.status === 'applied')).toHaveLength(10);
    expect(outcomes.filter((o) => o.status === 'insufficient')).toHaveLength(10);
    expect(await ledger.balance(ORG_A)).toBe(0);
    expect(sumOf(await ledger.entries(ORG_A))).toBe(0);
  });

  it('parallel spends of mixed sizes never overdraw', async () => {
    const ledger = await funded(100);
    const sizes = [60, 50, 40, 30, 20, 10, 7, 3, 1, 99];
    await Promise.all(
      sizes.map((size, i) =>
        ledger.spend(ORG_A, {
          idempotencyKey: `s${i}`,
          amount: credits(size),
          reason: 'generation',
        }),
      ),
    );
    const balance = await ledger.balance(ORG_A);
    expect(balance).toBeGreaterThanOrEqual(0);
    expect(balance).toBe(sumOf(await ledger.entries(ORG_A)));
  });

  it('twenty parallel calls with one key and one request charge once and all get the original', async () => {
    const ledger = await funded(10);
    const request = { idempotencyKey: 'job-1', amount: credits(3), reason: 'generation' } as const;
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => ledger.spend(ORG_A, { ...request })),
    );
    const [first] = outcomes;
    expect(first?.status).toBe('applied');
    for (const outcome of outcomes) expect(outcome).toEqual(first);
    expect(await ledger.balance(ORG_A)).toBe(7);
    expect(await ledger.entries(ORG_A)).toHaveLength(2);
  });

  it('parallel grants with one key add once', async () => {
    const ledger = newLedger();
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () =>
        ledger.grant(ORG_A, { idempotencyKey: 'g1', amount: credits(5) }),
      ),
    );
    expect(new Set(outcomes.map((o) => o.entry.id)).size).toBe(1);
    expect(await ledger.balance(ORG_A)).toBe(5);
  });

  it('parallel calls with one key and different amounts: one wins, the rest conflict', async () => {
    const ledger = await funded(1_000);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        asyncCodeOf(() =>
          ledger.spend(ORG_A, {
            idempotencyKey: 'job-1',
            amount: credits(i + 1),
            reason: 'generation',
          }),
        ),
      ),
    );
    expect(results.filter((r) => r === 'no error')).toHaveLength(1);
    expect(results.filter((r) => r === 'CREDIT_IDEMPOTENCY_CONFLICT')).toHaveLength(19);
    const entries = await ledger.entries(ORG_A);
    expect(entries).toHaveLength(2);
    expect(await ledger.balance(ORG_A)).toBe(sumOf(entries));
  });

  it('parallel reversals of one spend under different keys return it once', async () => {
    const ledger = await funded(10);
    const spend = await ledger.spend(ORG_A, {
      idempotencyKey: 's1',
      amount: credits(4),
      reason: 'generation',
    });
    if (spend.status !== 'applied') throw new Error('setup failed');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        asyncCodeOf(() =>
          ledger.reverse(ORG_A, { idempotencyKey: `r${i}`, entryId: spend.entry.id }),
        ),
      ),
    );
    expect(results.filter((r) => r === 'no error')).toHaveLength(1);
    expect(results.filter((r) => r === 'CREDIT_NOT_REVERSIBLE')).toHaveLength(9);
    expect(await ledger.balance(ORG_A)).toBe(10);
  });

  it('a spend racing a grant either fits or is refused, never overdraws', async () => {
    const ledger = await funded(5);
    const [spend] = await Promise.all([
      ledger.spend(ORG_A, { idempotencyKey: 's1', amount: credits(8), reason: 'generation' }),
      ledger.grant(ORG_A, { idempotencyKey: 'g2', amount: credits(5) }),
    ]);
    const balance = await ledger.balance(ORG_A);
    expect(balance).toBe(spend.status === 'applied' ? 2 : 10);
    expect(balance).toBe(sumOf(await ledger.entries(ORG_A)));
  });

  it('parallel spends in one organization do not block or touch another', async () => {
    const ledger = await funded(5);
    await ledger.grant(ORG_B, { idempotencyKey: 'seed', amount: credits(5) });
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        Promise.all([
          ledger.spend(ORG_A, {
            idempotencyKey: `s${i}`,
            amount: credits(1),
            reason: 'generation',
          }),
          ledger.spend(ORG_B, {
            idempotencyKey: `s${i}`,
            amount: credits(1),
            reason: 'generation',
          }),
        ]),
      ),
    );
    expect(await ledger.balance(ORG_A)).toBe(0);
    expect(await ledger.balance(ORG_B)).toBe(0);
    expect(await ledger.entries(ORG_A)).toHaveLength(6);
    expect(await ledger.entries(ORG_B)).toHaveLength(6);
  });

  it('a rejected call in a parallel batch does not poison the others', async () => {
    const ledger = await funded(10);
    const results = await Promise.all([
      asyncCodeOf(() =>
        ledger.spend(ORG_A, { idempotencyKey: 'ok-1', amount: credits(2), reason: 'generation' }),
      ),
      asyncCodeOf(() =>
        ledger.spend(ORG_A, { idempotencyKey: 'bad', amount: 0.5 as never, reason: 'generation' }),
      ),
      asyncCodeOf(() =>
        ledger.spend(ORG_A, { idempotencyKey: 'ok-2', amount: credits(2), reason: 'generation' }),
      ),
    ]);
    expect(results).toEqual(['no error', 'CREDIT_AMOUNT_INVALID', 'no error']);
    expect(await ledger.balance(ORG_A)).toBe(6);
  });
});
