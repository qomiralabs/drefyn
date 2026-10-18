import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { credits, type CreditEntry, type CreditEntryId } from '../src/index.ts';
import { Model, ORGS, keyArb, opArb, opsArb, runOp, type Op, type Result } from './model.ts';
import { ORG_A, newLedger, runs, snapshot, sumOf } from './support.ts';

const uniqueKeys = fc.uuid();

describe('ledger properties', () => {
  it('never lets a balance go below zero, after every step and in every organization', async () => {
    await fc.assert(
      fc.asyncProperty(opsArb(), async (ops) => {
        const ledger = newLedger();
        const spends = new Map<number, CreditEntryId[]>();
        for (const op of ops) {
          await runOp(ledger, op, spends);
          for (const org of ORGS) {
            const balance = await ledger.balance(org);
            expect(Number.isSafeInteger(balance)).toBe(true);
            expect(balance).toBeGreaterThanOrEqual(0);
          }
        }
      }),
      runs,
    );
  });

  it('always reports a balance equal to the sum of its entries', async () => {
    await fc.assert(
      fc.asyncProperty(opsArb(), async (ops) => {
        const ledger = newLedger();
        const spends = new Map<number, CreditEntryId[]>();
        for (const op of ops) {
          await runOp(ledger, op, spends);
          const org = ORGS[op.org];
          if (org === undefined) throw new Error('bad org index');
          expect(await ledger.balance(org)).toBe(sumOf(await ledger.entries(org)));
        }
      }),
      runs,
    );
  });

  it('only ever appends: earlier entries never change, vanish or reorder', async () => {
    await fc.assert(
      fc.asyncProperty(opsArb(), async (ops) => {
        const ledger = newLedger();
        const spends = new Map<number, CreditEntryId[]>();
        const seen = new Map<number, readonly CreditEntry[]>();
        for (const op of ops) {
          await runOp(ledger, op, spends);
          const org = ORGS[op.org];
          if (org === undefined) throw new Error('bad org index');
          const now = await ledger.entries(org);
          const before = seen.get(op.org) ?? [];
          expect(now.length - before.length).toBeGreaterThanOrEqual(0);
          expect(now.length - before.length).toBeLessThanOrEqual(1);
          expect(now.slice(0, before.length)).toEqual(before);
          seen.set(op.org, [...now]);
        }
      }),
      runs,
    );
  });

  it('gives every entry a unique ID and every key at most one entry per organization', async () => {
    await fc.assert(
      fc.asyncProperty(opsArb(), async (ops) => {
        const ledger = newLedger();
        const spends = new Map<number, CreditEntryId[]>();
        for (const op of ops) await runOp(ledger, op, spends);
        const ids: string[] = [];
        for (const org of ORGS) {
          const entries = await ledger.entries(org);
          ids.push(...entries.map((e) => e.id));
          const keys = entries.map((e) => e.idempotencyKey);
          expect(new Set(keys).size).toBe(keys.length);
          for (const entry of entries) expect(entry.organizationId).toBe(org.organizationId);
        }
        expect(new Set(ids).size).toBe(ids.length);
      }),
      runs,
    );
  });

  it('matches the reference model on every outcome and on the final ledger', async () => {
    await fc.assert(
      fc.asyncProperty(opsArb(), async (ops) => {
        const ledger = newLedger();
        const model = new Model();
        const spends = new Map<number, CreditEntryId[]>();
        for (const [index, op] of ops.entries()) {
          const expected = model.apply(op);
          const actual = await runOp(ledger, op, spends);
          expect(actual, `step ${index}: ${JSON.stringify(op)}`).toBe(expected);
        }
        for (const [index, org] of ORGS.entries()) {
          expect(await snapshot(ledger, org)).toEqual(model.snapshot(index));
        }
      }),
      runs,
    );
  });
});

describe('idempotency properties', () => {
  // The issue's form: duplicates of applied requests change nothing, wherever they land.
  // A refused request records nothing, so its key stays free; it is repeated right after
  // itself, where the state is unchanged and the retry is refused the same way.
  it('with repeated keys, the balance equals the balance with the duplicates removed', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(opArb(ORGS.length, uniqueKeys), { minLength: 1, maxLength: 30 }),
        fc.array(fc.tuple(fc.nat(), fc.nat()), { maxLength: 20 }),
        async (base, placements) => {
          const once = newLedger();
          const onceSpends = new Map<number, CreditEntryId[]>();
          const applied: boolean[] = [];
          for (const op of base) applied.push((await runOp(once, op, onceSpends)) === 'applied');

          const slots: Op[][] = base.map((op) => [op]);
          for (const [from, to] of placements) {
            const i = from % base.length;
            const op = base[i];
            if (op === undefined) continue;
            if (applied[i] === true) {
              const later = i + (to % (base.length - i));
              slots[later]?.push(op);
            } else {
              slots[i]?.push(op);
            }
          }
          const withDuplicates = newLedger();
          const dupSpends = new Map<number, CreditEntryId[]>();
          for (const op of slots.flat()) await runOp(withDuplicates, op, dupSpends);

          for (const org of ORGS) {
            expect(await withDuplicates.balance(org)).toBe(await once.balance(org));
            expect(await snapshot(withDuplicates, org)).toEqual(await snapshot(once, org));
          }
        },
      ),
      runs,
    );
  });

  it('a retry right after any call gives the same result and changes nothing', async () => {
    await fc.assert(
      fc.asyncProperty(opsArb(), async (ops) => {
        const once = newLedger();
        const twice = newLedger();
        const onceSpends = new Map<number, CreditEntryId[]>();
        const twiceSpends = new Map<number, CreditEntryId[]>();
        for (const op of ops) {
          const first = await runOp(once, op, onceSpends);
          const a = await runOp(twice, op, twiceSpends);
          const b = await runOp(twice, op, twiceSpends);
          expect(a).toBe(first);
          expect(b).toBe(a);
        }
        for (const org of ORGS)
          expect(await snapshot(twice, org)).toEqual(await snapshot(once, org));
      }),
      runs,
    );
  });

  it('a key reused with a different request is always a conflict that changes nothing', async () => {
    await fc.assert(
      fc.asyncProperty(opsArb(1, fc.constant('same-key')), async (ops) => {
        const ledger = newLedger();
        const spends = new Map<number, CreditEntryId[]>();
        let firstApplied: string | undefined;
        for (const op of ops) {
          const before = await snapshot(ledger, ORG_A);
          const result: Result = await runOp(ledger, op, spends);
          const request = JSON.stringify({ ...op, key: undefined });
          if (firstApplied !== undefined && request !== firstApplied && op.kind !== 'reversal') {
            expect(result).toBe('CREDIT_IDEMPOTENCY_CONFLICT');
            expect(await snapshot(ledger, ORG_A)).toEqual(before);
          }
          if (firstApplied === undefined && result === 'applied') firstApplied = request;
        }
        expect((await ledger.entries(ORG_A)).length).toBeLessThanOrEqual(1);
      }),
      runs,
    );
  });
});

describe('isolation properties', () => {
  it('an organization ends in the same state whatever other organizations do around it', async () => {
    await fc.assert(
      fc.asyncProperty(opsArb(), async (ops) => {
        const shared = newLedger();
        const sharedSpends = new Map<number, CreditEntryId[]>();
        for (const op of ops) await runOp(shared, op, sharedSpends);
        for (const [index, org] of ORGS.entries()) {
          const alone = newLedger();
          const aloneSpends = new Map<number, CreditEntryId[]>();
          for (const op of ops.filter((o) => o.org === index)) await runOp(alone, op, aloneSpends);
          expect(await snapshot(shared, org)).toEqual(await snapshot(alone, org));
        }
      }),
      runs,
    );
  });
});

describe('concurrency properties', () => {
  // The scheduler starts the calls in a random order and lets them interleave at every await.
  it('under any interleaving: never negative, balance equals entries, one entry per key', async () => {
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), opsArb(), async (s, ops) => {
        const ledger = newLedger();
        const spends = new Map<number, CreditEntryId[]>();
        const results: Promise<Result>[] = ops.map((op) =>
          s.schedule(Promise.resolve(op)).then((scheduled) => runOp(ledger, scheduled, spends)),
        );
        await s.waitIdle();
        const settled = await Promise.all(results);
        for (const result of settled) expect(result).not.toBe('not a CreditError');
        for (const org of ORGS) {
          const entries = await ledger.entries(org);
          const balance = await ledger.balance(org);
          expect(balance).toBeGreaterThanOrEqual(0);
          expect(balance).toBe(sumOf(entries));
          const keys = entries.map((e) => e.idempotencyKey);
          expect(new Set(keys).size).toBe(keys.length);
          let running = 0;
          for (const entry of entries) {
            running +=
              entry.kind === 'grant' || entry.kind === 'reversal' ? entry.amount : 0 - entry.amount;
            expect(running).toBeGreaterThanOrEqual(0);
          }
        }
      }),
      { ...runs, numRuns: 200 },
    );
  });

  it('under any interleaving, the same request under one key yields one entry and one outcome', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.integer({ min: 2, max: 25 }),
        keyArb,
        async (s, copies, key) => {
          const ledger = newLedger();
          const spends = new Map<number, CreditEntryId[]>();
          await runOp(ledger, { org: 0, kind: 'grant', key: `seed-${key}`, amount: 100 }, spends);
          const op: Op = { org: 0, kind: 'spend', key, amount: 7, reason: 'generation' };
          const outcomes = Array.from({ length: copies }, () =>
            s.schedule(Promise.resolve(op)).then((scheduled) =>
              ledger.spend(ORG_A, {
                idempotencyKey: scheduled.key,
                amount: credits(7),
                reason: 'generation',
              }),
            ),
          );
          await s.waitIdle();
          const settled = await Promise.all(outcomes);
          for (const outcome of settled) expect(outcome).toEqual(settled[0]);
          expect(settled[0]?.status).toBe('applied');
          expect(await ledger.balance(ORG_A)).toBe(93);
        },
      ),
      { ...runs, numRuns: 200 },
    );
  });
});
