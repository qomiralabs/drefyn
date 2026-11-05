import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createOptimisticStore,
  OptimisticRefused,
  type OptimisticToast,
} from '../src/optimistic/store.ts';

interface Item {
  readonly id: string;
  readonly value: number;
  // Only the server writes this, so a guess on the client can never match it by luck.
  readonly version: number;
}

type Step =
  | { readonly kind: 'update'; readonly ids: readonly string[]; readonly value: number }
  | { readonly kind: 'undo'; readonly which: number };

const IDS = ['a', 'b', 'c'] as const;

const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant('update' as const),
    ids: fc.subarray([...IDS], { minLength: 1 }),
    value: fc.integer({ min: 0, max: 9 }),
  }),
  fc.record({ kind: fc.constant('undo' as const), which: fc.nat({ max: 16 }) }),
);

const steps = fc.array(step, { maxLength: 16 });
// Which requests the server refuses, in arrival order, repeating.
const refusals = fc.array(fc.boolean(), { minLength: 1, maxLength: 7 });

const seed = (): Item[] => IDS.map((id) => ({ id, value: 0, version: 0 }));

// Every request is an await the scheduler can hold, and each person's step is scheduled too,
// so runs explore requests answered in any order against steps taken at any moment.
function world(s: fc.Scheduler, plan: readonly boolean[]) {
  const server = new Map(seed().map((item) => [item.id, item]));
  let calls = 0;

  const write = async (values: readonly { id: string; value: number }[]) => {
    const refused = plan[calls % plan.length];
    calls += 1;
    await s.schedule(Promise.resolve('reaches the server'));
    if (refused === true) throw new OptimisticRefused('conflict');
    const written = values.map(({ id, value }) => {
      const old = server.get(id);
      if (old === undefined) throw new Error(`no item ${id}`);
      const next = { id, value, version: old.version + 1 };
      server.set(id, next);
      return next;
    });
    await s.schedule(Promise.resolve('answer comes back'));
    return written;
  };

  const toasts: { undo: NonNullable<OptimisticToast['undo']>; closed: boolean }[] = [];
  const store = createOptimisticStore<Item>({
    initial: seed(),
    context: { organizationId: 'org_acme', projectId: 'prj_payments' },
    logWarn: () => undefined,
    toast: (input) => {
      const entry = { undo: input.undo ?? (() => Promise.resolve()), closed: false };
      if (input.undo !== undefined) toasts.push(entry);
      return {
        close: () => {
          entry.closed = true;
        },
      };
    },
  });

  const take = (next: Step): void => {
    if (next.kind === 'update') {
      store.run({
        action: 'items.set',
        ids: next.ids,
        apply: (item) => ({ ...item, value: next.value }),
        send: () => write(next.ids.map((id) => ({ id, value: next.value }))),
        revert: (before) => write(before),
        done: 'Changed.',
        undone: 'Undone.',
        failed: 'Could not change.',
      });
      return;
    }
    const open = toasts.filter((t) => !t.closed);
    if (open.length === 0) return;
    const toast = open[next.which % open.length];
    if (toast === undefined) return;
    toast.closed = true;
    // The real toast turns a refused undo into its own error, so nothing is left to catch.
    toast.undo().catch(() => undefined);
  };

  return { store, take, server: () => IDS.map((id) => server.get(id)) };
}

describe('once settled, what shows is what the server holds', () => {
  it('for any sequence of updates, undos and refusals, interleaved any way', async () => {
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), steps, refusals, async (s, sequence, plan) => {
        const { store, take, server } = world(s, plan);
        s.scheduleSequence(
          sequence.map((next, i) => ({
            label: `step ${String(i)}`,
            builder: () => {
              take(next);
              return Promise.resolve();
            },
          })),
        );
        await s.waitIdle();
        await store.idle();
        expect(store.get()).toEqual(server());
      }),
      { numRuns: 400 },
    );
  });

  it('with no refusals too, where only ordering can go wrong', async () => {
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), steps, async (s, sequence) => {
        const { store, take, server } = world(s, [false]);
        for (const next of sequence) take(next);
        await s.waitIdle();
        await store.idle();
        expect(store.get()).toEqual(server());
      }),
      { numRuns: 200 },
    );
  });

  it('with every request refused, where nothing may stick', async () => {
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), steps, async (s, sequence) => {
        const { store, take, server } = world(s, [true]);
        for (const next of sequence) take(next);
        await s.waitIdle();
        await store.idle();
        expect(store.get()).toEqual(seed());
        expect(server()).toEqual(seed());
      }),
      { numRuns: 100 },
    );
  });
});
