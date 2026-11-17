import fc from 'fast-check';
import { beforeAll, expect, it } from 'vitest';
import type { Database } from '@drefyn/db';
import {
  MAX_QUEUED_PER_BINDING,
  type ClaimedDelivery,
  type GitSyncStore,
} from '../../src/index.ts';
import {
  admin,
  BINDING,
  fakeClock,
  pools,
  recordingLogger,
  seed,
  sha,
  storeOver,
  value,
  type Seeded,
} from '../support/fixture.ts';
import { describeWithStack } from '../support/presence.ts';

const open = pools();
let first: Database;
let second: Database;

beforeAll(async () => {
  first = await open();
  second = await open();
});

const states = async (seeded: Seeded) =>
  (
    await admin(`
select delivery_id || '=' || state from app.git_deliveries
 where organization_id = '${seeded.organization}' and project_id = '${seeded.project}'
 order by delivery_id;`)
  )
    .split('\n')
    .filter((line) => line !== '');

async function bound(store: GitSyncStore, seeded: Seeded) {
  return value(await store.createBinding(seeded.tenant, BINDING));
}

const done = () => Promise.resolve('done' as const);

describeWithStack('the delivery queue', () => {
  it('stores the same delivery id once', async () => {
    const seeded = await seed();
    const store = storeOver(first);
    const binding = await bound(store, seeded);
    const input = { bindingId: binding.id, deliveryId: 'gh-1', headSha: sha(1) };
    expect(value(await store.enqueueDelivery(seeded.tenant, input))).toEqual({ stored: true });
    expect(value(await store.enqueueDelivery(seeded.tenant, input))).toEqual({ stored: false });
    expect(await states(seeded)).toEqual(['gh-1=queued']);
  });

  it('keeps a redelivered id stored once even after it ran', async () => {
    const seeded = await seed();
    const store = storeOver(first);
    const binding = await bound(store, seeded);
    const input = { bindingId: binding.id, deliveryId: 'gh-1', headSha: sha(1) };
    await store.enqueueDelivery(seeded.tenant, input);
    value(await store.claimDelivery(seeded.tenant, binding.id, done));
    expect(value(await store.enqueueDelivery(seeded.tenant, input))).toEqual({ stored: false });
    expect(await states(seeded)).toEqual(['gh-1=done']);
  });

  it('claims only the newest of three and marks the others done', async () => {
    const seeded = await seed();
    const clock = fakeClock();
    const store = storeOver(first, { clock });
    const binding = await bound(store, seeded);
    for (const n of [1, 2, 3]) {
      await store.enqueueDelivery(seeded.tenant, {
        bindingId: binding.id,
        deliveryId: `gh-${String(n)}`,
        headSha: sha(n),
      });
      clock.advance(1000);
    }
    const ran: ClaimedDelivery[] = [];
    const claim = value(
      await store.claimDelivery(seeded.tenant, binding.id, (delivery) => {
        ran.push(delivery);
        return done();
      }),
    );
    expect(ran.map((d) => d.deliveryId)).toEqual(['gh-3']);
    expect(claim).toMatchObject({ outcome: 'done', superseded: 2 });
    expect(claim.claimed).toMatchObject({ deliveryId: 'gh-3', headSha: sha(3) });
    expect(await states(seeded)).toEqual(['gh-1=done', 'gh-2=done', 'gh-3=done']);
    const again = value(await store.claimDelivery(seeded.tenant, binding.id, done));
    expect(again).toEqual({ claimed: null, outcome: null, superseded: 0 });
  });

  it('breaks a tie in arrival time by the later id', async () => {
    const seeded = await seed();
    const store = storeOver(first, { clock: fakeClock() });
    const binding = await bound(store, seeded);
    for (const id of ['gh-a', 'gh-b']) {
      await store.enqueueDelivery(seeded.tenant, {
        bindingId: binding.id,
        deliveryId: id,
        headSha: null,
      });
    }
    const claim = value(await store.claimDelivery(seeded.tenant, binding.id, done));
    expect(claim.claimed?.deliveryId).toBe('gh-b');
    expect(claim.superseded).toBe(1);
  });

  it('records a failed run and leaves a newer arrival queued', async () => {
    const seeded = await seed();
    const clock = fakeClock();
    const store = storeOver(first, { clock });
    const binding = await bound(store, seeded);
    await store.enqueueDelivery(seeded.tenant, {
      bindingId: binding.id,
      deliveryId: 'gh-1',
      headSha: sha(1),
    });
    clock.advance(1000);
    const claim = await store.claimDelivery(seeded.tenant, binding.id, async () => {
      // Lands while the claim runs: newer, so the next turn must still see it.
      await storeOver(second, { clock }).enqueueDelivery(seeded.tenant, {
        bindingId: binding.id,
        deliveryId: 'gh-2',
        headSha: sha(2),
      });
      return 'failed';
    });
    expect(value(claim)).toMatchObject({ outcome: 'failed', superseded: 0 });
    expect(await states(seeded)).toEqual(['gh-1=failed', 'gh-2=queued']);
  });

  it('rolls everything back when the work throws', async () => {
    const seeded = await seed();
    const clock = fakeClock();
    const store = storeOver(first, { clock });
    const binding = await bound(store, seeded);
    for (const n of [1, 2]) {
      await store.enqueueDelivery(seeded.tenant, {
        bindingId: binding.id,
        deliveryId: `gh-${String(n)}`,
        headSha: sha(n),
      });
      clock.advance(1000);
    }
    await expect(
      store.claimDelivery(seeded.tenant, binding.id, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(await states(seeded)).toEqual(['gh-1=queued', 'gh-2=queued']);
  });

  it('keeps at most the newest queued deliveries per binding', async () => {
    const seeded = await seed();
    const clock = fakeClock();
    const store = storeOver(first, { clock });
    const binding = await bound(store, seeded);
    const total = MAX_QUEUED_PER_BINDING + 5;
    for (let n = 0; n < total; n += 1) {
      await store.enqueueDelivery(seeded.tenant, {
        bindingId: binding.id,
        deliveryId: `gh-${String(n).padStart(4, '0')}`,
        headSha: null,
      });
      clock.advance(10);
    }
    const all = await states(seeded);
    expect(all.filter((line) => line.endsWith('=queued'))).toHaveLength(MAX_QUEUED_PER_BINDING);
    expect(all.slice(0, 5).every((line) => line.endsWith('=done'))).toBe(true);
  });

  it('refuses a binding of another tenant, an unknown one and bad input', async () => {
    const owner = await seed();
    const other = await seed();
    const store = storeOver(first);
    const binding = await bound(store, owner);
    const input = { bindingId: binding.id, deliveryId: 'gh-1', headSha: null };
    expect(await store.enqueueDelivery(other.tenant, input)).toEqual({
      ok: false,
      error: 'git_sync.binding_not_found',
    });
    expect(await store.claimDelivery(other.tenant, binding.id, done)).toEqual({
      ok: false,
      error: 'git_sync.binding_not_found',
    });
    expect(
      await store.enqueueDelivery(owner.tenant, { ...input, deliveryId: 'has space' }),
    ).toEqual({ ok: false, error: 'git_sync.input_invalid' });
    expect(await store.claimDelivery(owner.tenant, 'not-a-uuid', done)).toEqual({
      ok: false,
      error: 'git_sync.input_invalid',
    });
  });

  it('runs nothing for a paused binding', async () => {
    const seeded = await seed();
    const store = storeOver(first);
    const binding = await bound(store, seeded);
    await store.enqueueDelivery(seeded.tenant, {
      bindingId: binding.id,
      deliveryId: 'gh-1',
      headSha: null,
    });
    value(await store.pauseBinding(seeded.tenant, binding.id, 'git.unauthorized'));
    let ran = false;
    const claim = await store.claimDelivery(seeded.tenant, binding.id, () => {
      ran = true;
      return done();
    });
    expect(claim).toEqual({ ok: false, error: 'git_sync.binding_inactive' });
    expect(ran).toBe(false);
    expect(await states(seeded)).toEqual(['gh-1=queued']);
  });

  it('never lets two workers hold one binding', async () => {
    const seeded = await seed();
    const logger = recordingLogger();
    const one = storeOver(first, { logger });
    const two = storeOver(second, { logger });
    const binding = await bound(one, seeded);
    await one.enqueueDelivery(seeded.tenant, {
      bindingId: binding.id,
      deliveryId: 'gh-1',
      headSha: sha(1),
    });
    const holding = Promise.withResolvers<undefined>();
    const inside = Promise.withResolvers<undefined>();
    const running = one.claimDelivery(seeded.tenant, binding.id, async () => {
      inside.resolve(undefined);
      await holding.promise;
      return 'done';
    });
    await inside.promise;
    // Another delivery is queued, so only the lock can be what turns the second worker away.
    await two.enqueueDelivery(seeded.tenant, {
      bindingId: binding.id,
      deliveryId: 'gh-2',
      headSha: sha(2),
    });
    expect(await two.claimDelivery(seeded.tenant, binding.id, done)).toEqual({
      ok: false,
      error: 'git_sync.busy',
    });
    holding.resolve(undefined);
    expect(value(await running).claimed?.deliveryId).toBe('gh-1');
    expect(
      value(await two.claimDelivery(seeded.tenant, binding.id, done)).claimed?.deliveryId,
    ).toBe('gh-2');
    expect(logger.lines.some((line) => line.fields['code'] === 'git_sync.busy')).toBe(true);
  });

  it('runs each delivery at most once when many workers race', async () => {
    const seeded = await seed();
    const clock = fakeClock();
    const one = storeOver(first, { clock });
    const two = storeOver(second, { clock });
    const binding = await bound(one, seeded);
    let holders = 0;
    let most = 0;
    const ran: string[] = [];
    const work = async (delivery: ClaimedDelivery) => {
      holders += 1;
      most = Math.max(most, holders);
      ran.push(delivery.deliveryId);
      await new Promise((resolve) => setTimeout(resolve, 5));
      holders -= 1;
      return 'done' as const;
    };
    for (let round = 0; round < 10; round += 1) {
      await one.enqueueDelivery(seeded.tenant, {
        bindingId: binding.id,
        deliveryId: `gh-${String(round)}`,
        headSha: null,
      });
      clock.advance(1000);
      await Promise.all([
        one.claimDelivery(seeded.tenant, binding.id, work),
        two.claimDelivery(seeded.tenant, binding.id, work),
      ]);
    }
    expect(most).toBe(1);
    expect(new Set(ran).size).toBe(ran.length);
  });

  it('leaves nothing queued after a claim, for any order and repetition of enqueues', async () => {
    const seeded = await seed();
    const clock = fakeClock();
    const store = storeOver(first, { clock });
    const binding = await bound(store, seeded);
    let round = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ id: fc.integer({ min: 0, max: 5 }), gap: fc.nat(3) }), {
          minLength: 1,
          maxLength: 12,
        }),
        async (enqueues) => {
          round += 1;
          const ids = new Set<string>();
          for (const { id, gap } of enqueues) {
            const deliveryId = `r${String(round)}-${String(id)}`;
            ids.add(deliveryId);
            await store.enqueueDelivery(seeded.tenant, {
              bindingId: binding.id,
              deliveryId,
              headSha: null,
            });
            clock.advance(gap);
          }
          const claim = value(await store.claimDelivery(seeded.tenant, binding.id, done));
          const lines = await states(seeded);
          const mine = lines.filter((line) => line.startsWith(`r${String(round)}-`));
          expect(mine).toHaveLength(ids.size);
          expect(lines.filter((line) => line.endsWith('=queued'))).toEqual([]);
          expect(claim.superseded).toBe(ids.size - 1);
        },
      ),
      { numRuns: 15 },
    );
  });
});
