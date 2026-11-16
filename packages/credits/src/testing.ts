// Test helpers. Production code never imports this entry point. Any AiBudget a host builds,
// over any ledger, should pass aiBudgetContract before it meters a real pool.
import type { TenantRef } from '@drefyn/tenancy';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { credits, type Credits } from './amounts.ts';
import { AI_OPERATIONS, type AiBudget, type AiOperation } from './budget.ts';
import { CreditError, type CreditErrorCode } from './errors.ts';
import type { CreditEntry, CreditEntryId, CreditLedger } from './ledger.ts';

export interface AiBudgetHarness {
  readonly budget: AiBudget;
  // The pool the budget draws on, so the suite can fund it and read back what was recorded.
  // It must start empty for the tenant below.
  readonly ledger: CreditLedger;
  readonly tenant: TenantRef;
  // What the budget charges for each operation, exactly as its host configured it.
  readonly creditsFor: (operation: AiOperation) => Credits;
}

export type AiBudgetFactory = () => AiBudgetHarness | Promise<AiBudgetHarness>;

// Fixed seed so a failure reproduces anywhere; raise numRuns locally to hunt.
const RUNS = { seed: 381, numRuns: 200 } as const;
// The interleaving property replays 200 schedules through fresh pools; generous so a loaded
// runner does not fail it, still short enough that a hang shows.
const PROPERTY_TIMEOUT_MS = 30_000;

type Outcome = CreditErrorCode | 'no error' | 'not a CreditError';

async function codeOf(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    await run();
  } catch (error) {
    return error instanceof CreditError ? error.code : 'not a CreditError';
  }
  return 'no error';
}

function signed(entry: CreditEntry): number {
  return entry.kind === 'grant' || entry.kind === 'reversal' || entry.kind === 'settlement'
    ? entry.amount
    : 0 - entry.amount;
}

function spendsWithKey(entries: readonly CreditEntry[], key: string): CreditEntry[] {
  return entries.filter((entry) => entry.kind === 'spend' && entry.idempotencyKey === key);
}

function reversalsOf(entries: readonly CreditEntry[], id: CreditEntryId): CreditEntry[] {
  return entries.filter((entry) => entry.kind === 'reversal' && entry.reverses === id);
}

type Step = 'charge' | 'charge_then_crash' | 'refund';

interface Turn {
  readonly operation: AiOperation;
  // Each worker is one process handling the turn: a first attempt, a retry, a double submit.
  readonly workers: readonly (readonly Step[])[];
}

const turnArb: fc.Arbitrary<Turn> = fc.record({
  operation: fc.constantFrom(...AI_OPERATIONS),
  workers: fc.array(
    fc.array(fc.constantFrom<Step>('charge', 'charge_then_crash', 'refund'), {
      minLength: 1,
      maxLength: 4,
    }),
    { minLength: 1, maxLength: 3 },
  ),
});

export function aiBudgetContract(make: AiBudgetFactory): void {
  async function funded(amount: number): Promise<AiBudgetHarness> {
    const harness = await make();
    if (amount > 0) {
      await harness.ledger.grant(harness.tenant, {
        idempotencyKey: 'contract-seed',
        amount: credits(amount),
      });
    }
    return harness;
  }

  async function charged(
    harness: AiBudgetHarness,
    key: string,
    operation: AiOperation,
  ): Promise<CreditEntryId> {
    const result = await harness.budget.charge(harness.tenant, { idempotencyKey: key, operation });
    if (result.status !== 'charged') throw new Error(`charge ${key} was ${result.status}`);
    return result.entryId;
  }

  describe('AiBudget contract', () => {
    for (const operation of AI_OPERATIONS) {
      it(`a ${operation} charge spends its configured credits with ${operation} as the reason`, async () => {
        const probe = await make();
        const cost = probe.creditsFor(operation);
        const h = await funded(cost * 2);
        const entryId = await charged(h, `turn:${operation}`, operation);

        const entries = await h.ledger.entries(h.tenant);
        expect(entries).toHaveLength(2);
        expect(entries[1]).toMatchObject({
          id: entryId,
          kind: 'spend',
          amount: cost,
          reason: operation,
          idempotencyKey: `turn:${operation}`,
          organizationId: h.tenant.organizationId,
        });
        expect(await h.ledger.balance(h.tenant)).toBe(cost);
      });
    }

    it('repeating a charge with its key returns the same entry and spends once', async () => {
      const h = await funded(1_000);
      const first = await charged(h, 'turn-1', 'reader_answer');
      const again = await charged(h, 'turn-1', 'reader_answer');
      expect(again).toBe(first);
      expect(spendsWithKey(await h.ledger.entries(h.tenant), 'turn-1')).toHaveLength(1);
      expect(await h.ledger.balance(h.tenant)).toBe(1_000 - h.creditsFor('reader_answer'));
    });

    it('parallel charges with one key spend once and all get the same entry', async () => {
      const h = await funded(1_000);
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          h.budget.charge(h.tenant, { idempotencyKey: 'turn-1', operation: 'stale_draft' }),
        ),
      );
      const ids = new Set(results.map((r) => (r.status === 'charged' ? r.entryId : r.status)));
      expect(ids.size).toBe(1);
      expect(spendsWithKey(await h.ledger.entries(h.tenant), 'turn-1')).toHaveLength(1);
    });

    it('a refund returns the whole charge, and repeating it changes nothing', async () => {
      const h = await funded(1_000);
      const entryId = await charged(h, 'turn-1', 'reader_answer');
      await expect(
        h.budget.refund(h.tenant, { idempotencyKey: 'refund-1', entryId }),
      ).resolves.toBeUndefined();
      await h.budget.refund(h.tenant, { idempotencyKey: 'refund-1', entryId });
      const entries = await h.ledger.entries(h.tenant);
      expect(reversalsOf(entries, entryId)).toHaveLength(1);
      expect(await h.ledger.balance(h.tenant)).toBe(1_000);
    });

    it('parallel refunds under one key reverse once', async () => {
      const h = await funded(1_000);
      const entryId = await charged(h, 'turn-1', 'reader_answer');
      await Promise.all(
        Array.from({ length: 10 }, () =>
          h.budget.refund(h.tenant, { idempotencyKey: 'refund-1', entryId }),
        ),
      );
      expect(reversalsOf(await h.ledger.entries(h.tenant), entryId)).toHaveLength(1);
      expect(await h.ledger.balance(h.tenant)).toBe(1_000);
    });

    it('a charge after its refund returns the refunded entry and spends nothing more', async () => {
      const h = await funded(1_000);
      const entryId = await charged(h, 'turn-1', 'reader_answer');
      await h.budget.refund(h.tenant, { idempotencyKey: 'refund-1', entryId });
      expect(await charged(h, 'turn-1', 'reader_answer')).toBe(entryId);
      expect(await h.ledger.balance(h.tenant)).toBe(1_000);
    });

    it('a charge the pool cannot cover is refused, records nothing and leaves the key free', async () => {
      const probe = await make();
      const cost = probe.creditsFor('reader_answer');
      const h = await funded(cost - 1);
      const before = await h.ledger.entries(h.tenant);
      expect(
        await h.budget.charge(h.tenant, { idempotencyKey: 'turn-1', operation: 'reader_answer' }),
      ).toEqual({ status: 'refused' });
      expect(await h.ledger.entries(h.tenant)).toEqual(before);

      await h.ledger.grant(h.tenant, { idempotencyKey: 'top-up', amount: credits(1) });
      await charged(h, 'turn-1', 'reader_answer');
      expect(await h.ledger.balance(h.tenant)).toBe(0);
    });

    it('a charge that lands exactly on the floor is charged', async () => {
      const probe = await make();
      const cost = probe.creditsFor('reader_answer');
      const h = await funded(cost + 50);
      const result = await h.budget.charge(h.tenant, {
        idempotencyKey: 'turn-1',
        operation: 'reader_answer',
        floor: credits(50),
      });
      expect(result.status).toBe('charged');
      expect(await h.ledger.balance(h.tenant)).toBe(50);
    });

    it('a charge that would pass the floor is refused, records nothing and leaves the key free', async () => {
      const probe = await make();
      const cost = probe.creditsFor('reader_answer');
      const h = await funded(cost + 49);
      const before = await h.ledger.entries(h.tenant);
      expect(
        await h.budget.charge(h.tenant, {
          idempotencyKey: 'turn-1',
          operation: 'reader_answer',
          floor: credits(50),
        }),
      ).toEqual({ status: 'refused' });
      expect(await h.ledger.entries(h.tenant)).toEqual(before);
      expect(await h.ledger.balance(h.tenant)).toBe(cost + 49);

      await charged(h, 'turn-1', 'reader_answer');
    });

    it('a floor above the whole pool refuses even an affordable charge', async () => {
      const h = await funded(1_000);
      expect(
        await h.budget.charge(h.tenant, {
          idempotencyKey: 'turn-1',
          operation: 'stale_draft',
          floor: credits(1_001),
        }),
      ).toEqual({ status: 'refused' });
      expect(await h.ledger.balance(h.tenant)).toBe(1_000);
    });

    it('a floor of zero is the same as no floor', async () => {
      const probe = await make();
      const cost = probe.creditsFor('stale_draft');
      const h = await funded(cost);
      const result = await h.budget.charge(h.tenant, {
        idempotencyKey: 'turn-1',
        operation: 'stale_draft',
        floor: credits(0),
      });
      expect(result.status).toBe('charged');
      expect(await h.ledger.balance(h.tenant)).toBe(0);
    });

    // Recovery after a crash repeats the charge without a floor to find the entry it made.
    it('a retry without a floor returns the original charge after the pool fell below the floor', async () => {
      const probe = await make();
      const cost = probe.creditsFor('reader_answer');
      const h = await funded(cost + 10);
      const first = await h.budget.charge(h.tenant, {
        idempotencyKey: 'turn-1',
        operation: 'reader_answer',
        floor: credits(10),
      });
      if (first.status !== 'charged') throw new Error('setup failed');
      await h.ledger.expire(h.tenant, { idempotencyKey: 'drain', amount: credits(10) });

      expect(await charged(h, 'turn-1', 'reader_answer')).toBe(first.entryId);
      expect(spendsWithKey(await h.ledger.entries(h.tenant), 'turn-1')).toHaveLength(1);
    });

    it(
      'sequential charges are refused exactly when they would pass the floor',
      async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.nat({ max: 200 }),
            fc.nat({ max: 100 }),
            fc.array(fc.constantFrom(...AI_OPERATIONS), { minLength: 1, maxLength: 12 }),
            async (pool, floor, operations) => {
              const h = await funded(pool);
              for (const [index, operation] of operations.entries()) {
                const before = await h.ledger.balance(h.tenant);
                const cost = h.creditsFor(operation);
                const result = await h.budget.charge(h.tenant, {
                  idempotencyKey: `turn-${index}`,
                  operation,
                  floor: credits(floor),
                });
                const after = await h.ledger.balance(h.tenant);
                if (before - cost < floor) {
                  expect(result).toEqual({ status: 'refused' });
                  expect(after).toBe(before);
                } else {
                  expect(result.status).toBe('charged');
                  expect(after).toBe(before - cost);
                  expect(after).toBeGreaterThanOrEqual(floor);
                }
              }
            },
          ),
          RUNS,
        );
      },
      PROPERTY_TIMEOUT_MS,
    );

    it('refuses a floor that is not a non negative safe integer and records nothing', async () => {
      const h = await funded(1_000);
      for (const floor of [0.5, 1.25, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '5', 5n]) {
        expect(
          await codeOf(() =>
            h.budget.charge(h.tenant, {
              idempotencyKey: 'turn-1',
              operation: 'reader_answer',
              floor: floor as Credits,
            }),
          ),
        ).toBe('CREDIT_AMOUNT_INVALID');
      }
      expect(await h.ledger.entries(h.tenant)).toHaveLength(1);
    });

    it(
      'refuses every fractional floor',
      async () => {
        const h = await funded(1_000);
        await fc.assert(
          fc.asyncProperty(
            fc.double({ noNaN: true, noDefaultInfinity: true }).filter((v) => !Number.isInteger(v)),
            async (floor) => {
              expect(
                await codeOf(() =>
                  h.budget.charge(h.tenant, {
                    idempotencyKey: 'turn-1',
                    operation: 'stale_draft',
                    floor: floor as Credits,
                  }),
                ),
              ).toBe('CREDIT_AMOUNT_INVALID');
            },
          ),
          RUNS,
        );
        expect(await h.ledger.entries(h.tenant)).toHaveLength(1);
      },
      PROPERTY_TIMEOUT_MS,
    );

    it('refuses an operation that is not an AI operation and records nothing', async () => {
      const h = await funded(1_000);
      for (const operation of [
        'generation',
        'incident_draft',
        'translation_draft',
        'Reader_answer',
        '',
        7,
      ]) {
        expect(
          await codeOf(() =>
            h.budget.charge(h.tenant, {
              idempotencyKey: 'turn-1',
              operation: operation as AiOperation,
            }),
          ),
        ).toBe('CREDIT_REASON_INVALID');
      }
      expect(await h.ledger.entries(h.tenant)).toHaveLength(1);
    });

    it('refuses a bad key or organization before anything else', async () => {
      const h = await funded(1_000);
      expect(
        await codeOf(() =>
          h.budget.charge(h.tenant, { idempotencyKey: '', operation: 'generation' as AiOperation }),
        ),
      ).toBe('CREDIT_KEY_INVALID');
      expect(
        await codeOf(() =>
          h.budget.charge({ organizationId: 'org' } as unknown as TenantRef, {
            idempotencyKey: '',
            operation: 'reader_answer',
          }),
        ),
      ).toBe('CREDIT_ORGANIZATION_INVALID');
      expect(
        await codeOf(() =>
          h.budget.refund(h.tenant, { idempotencyKey: '', entryId: 'x' as CreditEntryId }),
        ),
      ).toBe('CREDIT_KEY_INVALID');
      expect(await h.ledger.entries(h.tenant)).toHaveLength(1);
    });

    it('refuses to refund an entry this organization never charged', async () => {
      const h = await funded(1_000);
      expect(
        await codeOf(() =>
          h.budget.refund(h.tenant, {
            idempotencyKey: 'refund-1',
            entryId: '00000000-0000-0000-0000-000000000000' as CreditEntryId,
          }),
        ),
      ).toBe('CREDIT_ENTRY_NOT_FOUND');
    });

    it(
      'under every interleaving of charge, refund and crash, each turn is charged and refunded at most once',
      async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.array(turnArb, { minLength: 1, maxLength: 5 }),
            fc.nat({ max: 6 }),
            fc.scheduler(),
            async (turns, fundedTurns, scheduler) => {
              const probe = await make();
              const most = Math.max(...AI_OPERATIONS.map((op) => probe.creditsFor(op)));
              const pool = fundedTurns * most;
              const h = await funded(pool);
              const chargeKey = (turn: number): string => `contract-charge:${turn}`;
              const refundKey = (turn: number): string => `contract-refund:${turn}`;
              // The turn row: it survives a crash, the worker's memory does not.
              const recorded = new Map<number, CreditEntryId>();

              const worker = async (
                turn: number,
                operation: AiOperation,
                steps: readonly Step[],
              ): Promise<void> => {
                for (const step of steps) {
                  await scheduler.schedule(Promise.resolve(), `${step}:${turn}`);
                  if (step === 'refund') {
                    const entryId = recorded.get(turn);
                    if (entryId !== undefined) {
                      await h.budget.refund(h.tenant, { idempotencyKey: refundKey(turn), entryId });
                    }
                    continue;
                  }
                  const result = await h.budget.charge(h.tenant, {
                    idempotencyKey: chargeKey(turn),
                    operation,
                  });
                  // A crash right after the spend loses the answer before the row is written.
                  if (step === 'charge' && result.status === 'charged') {
                    recorded.set(turn, result.entryId);
                  }
                }
              };

              const runs = turns.flatMap((turn, index) =>
                turn.workers.map((steps) => worker(index, turn.operation, steps)),
              );
              await scheduler.waitFor(Promise.all(runs));

              const entries = await h.ledger.entries(h.tenant);
              let outstanding = 0;
              for (const [index, turn] of turns.entries()) {
                const spends = spendsWithKey(entries, chargeKey(index));
                expect(spends.length).toBeLessThanOrEqual(1);
                const [spend] = spends;
                const recordedId = recorded.get(index);
                if (spend === undefined) {
                  expect(recordedId).toBeUndefined();
                  continue;
                }
                expect(spend).toMatchObject({ amount: h.creditsFor(turn.operation) });
                if (recordedId !== undefined) expect(recordedId).toBe(spend.id);
                const reversals = reversalsOf(entries, spend.id);
                expect(reversals.length).toBeLessThanOrEqual(1);
                for (const reversal of reversals) {
                  expect(reversal.idempotencyKey).toBe(refundKey(index));
                }
                if (reversals.length === 0) outstanding += spend.amount;
              }
              const balance = await h.ledger.balance(h.tenant);
              expect(balance).toBe(entries.reduce((sum, entry) => sum + signed(entry), 0));
              expect(balance).toBe(pool - outstanding);
              expect(balance).toBeGreaterThanOrEqual(0);

              // The sweeper finds every spend still standing and refunds it under the same key.
              for (const [index] of turns.entries()) {
                const [spend] = spendsWithKey(entries, chargeKey(index));
                if (spend === undefined) continue;
                await h.budget.refund(h.tenant, {
                  idempotencyKey: refundKey(index),
                  entryId: spend.id,
                });
              }
              const swept = await h.ledger.entries(h.tenant);
              for (const spend of swept.filter((entry) => entry.kind === 'spend')) {
                expect(reversalsOf(swept, spend.id)).toHaveLength(1);
              }
              expect(await h.ledger.balance(h.tenant)).toBe(pool);
            },
          ),
          RUNS,
        );
      },
      PROPERTY_TIMEOUT_MS,
    );
  });
}
