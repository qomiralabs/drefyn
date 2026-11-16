import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
  AI_OPERATIONS,
  SPEND_REASONS,
  createLedgerBudget,
  createMemoryLedger,
  credits,
  unmeteredBudget,
  type AiOperation,
  type CreditEntryId,
  type Credits,
} from '../src/index.ts';
import { aiBudgetContract } from '../src/testing.ts';
import { ORG_A, PROPERTY_TIMEOUT_MS, asyncCodeOf, runs, tenantOf } from './support.ts';

// Fixture costs for the tests only. Real costs are set by whoever runs the pool.
const FIXTURE_COSTS: Readonly<Record<AiOperation, number>> = {
  stale_draft: 7,
  reader_answer: 3,
  translation_draft: 5,
  incident_draft: 4,
  generation: 11,
};
const TENANT = tenantOf(ORG_A, '01928c3e-7a9b-7c3d-8e4f-0123456789ff');

aiBudgetContract(() => {
  const ledger = createMemoryLedger();
  const creditsFor = (operation: AiOperation): Credits => credits(FIXTURE_COSTS[operation]);
  return { budget: createLedgerBudget({ ledger, creditsFor }), ledger, tenant: TENANT, creditsFor };
});

// The smallest cost hits the floor and empty pool edges one credit at a time.
aiBudgetContract(() => {
  const ledger = createMemoryLedger();
  const creditsFor = (): Credits => credits(1);
  return { budget: createLedgerBudget({ ledger, creditsFor }), ledger, tenant: TENANT, creditsFor };
});

describe('AI operations', () => {
  it('are every AI spend, frozen, and each is a spend reason', () => {
    expect([...AI_OPERATIONS]).toEqual([
      'stale_draft',
      'reader_answer',
      'translation_draft',
      'incident_draft',
      'generation',
    ]);
    expect([...AI_OPERATIONS].sort()).toEqual([...SPEND_REASONS].sort());
    expect(Object.isFrozen(AI_OPERATIONS)).toBe(true);
    for (const operation of AI_OPERATIONS) {
      expect(SPEND_REASONS as readonly string[]).toContain(operation);
    }
  });
});

describe('unmeteredBudget', () => {
  it('answers unmetered for every operation, with or without a floor, and keeps no state', async () => {
    const budget = unmeteredBudget();
    for (const operation of AI_OPERATIONS) {
      expect(await budget.charge(TENANT, { idempotencyKey: 'turn-1', operation })).toEqual({
        status: 'unmetered',
      });
      expect(
        await budget.charge(TENANT, {
          idempotencyKey: 'turn-1',
          operation,
          floor: credits(1_000_000),
        }),
      ).toEqual({ status: 'unmetered' });
    }
  });

  it('accepts a refund and does nothing with it', async () => {
    await expect(
      unmeteredBudget().refund(TENANT, {
        idempotencyKey: 'refund-1',
        entryId: '00000000-0000-0000-0000-000000000000' as CreditEntryId,
      }),
    ).resolves.toBeUndefined();
  });

  it('still refuses malformed requests, so self host and hosted fail the same way', async () => {
    const budget = unmeteredBudget();
    const charge = (ref: unknown, request: unknown) =>
      asyncCodeOf(() => budget.charge(ref as typeof TENANT, request as never));
    expect(await charge({}, { idempotencyKey: 'k', operation: 'reader_answer' })).toBe(
      'CREDIT_ORGANIZATION_INVALID',
    );
    expect(await charge(TENANT, { idempotencyKey: '', operation: 'reader_answer' })).toBe(
      'CREDIT_KEY_INVALID',
    );
    expect(await charge(TENANT, { idempotencyKey: 'k', operation: 'sms' })).toBe(
      'CREDIT_REASON_INVALID',
    );
    expect(
      await charge(TENANT, { idempotencyKey: 'k', operation: 'reader_answer', floor: 0.5 }),
    ).toBe('CREDIT_AMOUNT_INVALID');
    expect(
      await asyncCodeOf(() =>
        budget.refund(TENANT, { idempotencyKey: '', entryId: 'x' as CreditEntryId }),
      ),
    ).toBe('CREDIT_KEY_INVALID');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(unmeteredBudget())).toBe(true);
  });
});

describe('createLedgerBudget', () => {
  async function fundedLedger(amount: number) {
    const ledger = createMemoryLedger();
    await ledger.grant(ORG_A, { idempotencyKey: 'seed', amount: credits(amount) });
    return ledger;
  }

  it('returns each status: charged, then refused once the pool is spent', async () => {
    const ledger = await fundedLedger(3);
    const budget = createLedgerBudget({ ledger, creditsFor: () => credits(3) });
    const first = await budget.charge(TENANT, { idempotencyKey: 'a', operation: 'reader_answer' });
    expect(first.status).toBe('charged');
    expect(Object.keys(first).sort()).toEqual(['entryId', 'status']);
    expect(
      await budget.charge(TENANT, { idempotencyKey: 'b', operation: 'reader_answer' }),
    ).toEqual({ status: 'refused' });
  });

  it('asks for the cost of the operation being charged, once per charge', async () => {
    const ledger = await fundedLedger(100);
    const creditsFor = vi.fn((operation: AiOperation) => credits(FIXTURE_COSTS[operation]));
    const budget = createLedgerBudget({ ledger, creditsFor });
    await budget.charge(TENANT, { idempotencyKey: 'a', operation: 'stale_draft' });
    expect(creditsFor.mock.calls).toEqual([['stale_draft']]);
    expect(await ledger.balance(ORG_A)).toBe(93);
  });

  it('asks for no cost when the request is malformed', async () => {
    const creditsFor = vi.fn(() => credits(1));
    const budget = createLedgerBudget({ ledger: createMemoryLedger(), creditsFor });
    await asyncCodeOf(() =>
      budget.charge(TENANT, { idempotencyKey: 'a', operation: 'sms' as AiOperation }),
    );
    expect(creditsFor).not.toHaveBeenCalled();
  });

  it(
    'refuses every fractional cost and records nothing',
    async () => {
      const ledger = await fundedLedger(1_000_000);
      await fc.assert(
        fc.asyncProperty(
          fc.double({ noNaN: true, noDefaultInfinity: true }).filter((v) => !Number.isInteger(v)),
          async (cost) => {
            const budget = createLedgerBudget({ ledger, creditsFor: () => cost as Credits });
            expect(
              await asyncCodeOf(() =>
                budget.charge(TENANT, { idempotencyKey: 'a', operation: 'reader_answer' }),
              ),
            ).toBe('CREDIT_AMOUNT_INVALID');
          },
        ),
        runs,
      );
      expect(await ledger.entries(ORG_A)).toHaveLength(1);
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    'charges any whole cost the pool covers, exactly',
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 1_000_000 }), async (cost) => {
          const ledger = await fundedLedger(1_000_000);
          const budget = createLedgerBudget({ ledger, creditsFor: () => credits(cost) });
          const result = await budget.charge(TENANT, {
            idempotencyKey: 'a',
            operation: 'stale_draft',
          });
          expect(result.status).toBe('charged');
          expect(await ledger.balance(ORG_A)).toBe(1_000_000 - cost);
        }),
        runs,
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it('refuses a cost of zero, negative, unsafe or not a number, and records nothing', async () => {
    const ledger = await fundedLedger(1_000);
    for (const cost of [0, -3, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY, '3', 3n, null]) {
      const budget = createLedgerBudget({ ledger, creditsFor: () => cost as Credits });
      expect(
        await asyncCodeOf(() =>
          budget.charge(TENANT, { idempotencyKey: 'a', operation: 'reader_answer' }),
        ),
      ).toBe('CREDIT_AMOUNT_INVALID');
    }
    expect(await ledger.entries(ORG_A)).toHaveLength(1);
  });

  it('lets a failing cost lookup through and records nothing', async () => {
    const ledger = await fundedLedger(1_000);
    const budget = createLedgerBudget({
      ledger,
      creditsFor: () => {
        throw new Error('cost table unavailable');
      },
    });
    await expect(
      budget.charge(TENANT, { idempotencyKey: 'a', operation: 'reader_answer' }),
    ).rejects.toThrow('cost table unavailable');
    expect(await ledger.entries(ORG_A)).toHaveLength(1);
  });

  it('draws on the organization pool whichever project charges', async () => {
    const ledger = await fundedLedger(10);
    const budget = createLedgerBudget({ ledger, creditsFor: () => credits(4) });
    await budget.charge(tenantOf(ORG_A, '01928c3e-7a9b-7c3d-8e4f-0123456789f1'), {
      idempotencyKey: 'a',
      operation: 'reader_answer',
    });
    await budget.charge(tenantOf(ORG_A, '01928c3e-7a9b-7c3d-8e4f-0123456789f2'), {
      idempotencyKey: 'b',
      operation: 'reader_answer',
    });
    expect(await ledger.balance(ORG_A)).toBe(2);
  });

  it('is frozen', () => {
    const budget = createLedgerBudget({
      ledger: createMemoryLedger(),
      creditsFor: () => credits(1),
    });
    expect(Object.isFrozen(budget)).toBe(true);
  });
});

// Costs are injected by the host, so the budget source must not carry one of its own.
describe('no costs in the budget source', () => {
  it('has no numeric literal other than zero', () => {
    const file = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'src', 'budget.ts');
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true);
    scanner.setText(readFileSync(file, 'utf8'));
    const numbers: string[] = [];
    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
      const isNumber =
        kind === ts.SyntaxKind.NumericLiteral || kind === ts.SyntaxKind.BigIntLiteral;
      if (isNumber && scanner.getTokenText() !== '0') numbers.push(scanner.getTokenText());
    }
    expect(numbers).toEqual([]);
  });
});
