import { beforeAll, expect, it } from 'vitest';
import type { Database } from '@drefyn/db';
import type { TenantRef } from '@drefyn/tenancy';
import { reconcileOnce, type GitSyncGate } from '../../src/index.ts';
import {
  admin,
  BINDING,
  fakeClock,
  pools,
  seed,
  storeOver,
  value,
  type Seeded,
} from '../support/fixture.ts';
import { describeWithStack } from '../support/presence.ts';

const open = pools();
let db: Database;

beforeAll(async () => {
  db = await open();
});

async function* listed(tenants: readonly TenantRef[]): AsyncIterable<TenantRef> {
  for (const tenant of tenants) {
    await Promise.resolve();
    yield tenant;
  }
}

const queued = async (seeded: Seeded) =>
  (
    await admin(`
select delivery_id || '|' || coalesce(head_sha, 'null') from app.git_deliveries
 where organization_id = '${seeded.organization}' and project_id = '${seeded.project}'
   and state = 'queued' order by delivery_id;`)
  )
    .split('\n')
    .filter((line) => line !== '');

describeWithStack('the hourly reconcile', () => {
  it('queues one delivery per active binding and none for paused ones', async () => {
    const clock = fakeClock('2026-11-16T10:15:00.000Z');
    const store = storeOver(db, { clock });
    const [active, alsoActive, paused, unbound] = await Promise.all([
      seed(),
      seed(),
      seed(),
      seed(),
    ]);
    const bindings = new Map<Seeded, string>();
    for (const seeded of [active, alsoActive, paused]) {
      bindings.set(seeded, value(await store.createBinding(seeded.tenant, BINDING)).id);
    }
    value(await store.pauseBinding(paused.tenant, bindings.get(paused) ?? '', 'git.unauthorized'));
    const tenants = [active, alsoActive, paused, unbound].map((s) => s.tenant);

    const report = await reconcileOnce({ store, tenants: () => listed(tenants), clock: clock.now });
    expect(report).toEqual({ enqueued: 2, duplicate: 0, skipped: 2, failed: 0, truncated: false });
    for (const seeded of [active, alsoActive]) {
      expect(await queued(seeded)).toEqual([
        `reconcile:${bindings.get(seeded) ?? ''}:2026-11-16T10|null`,
      ]);
    }
    expect(await queued(paused)).toEqual([]);
    expect(await queued(unbound)).toEqual([]);

    // A second server, or a second run, in the same hour stores nothing new.
    clock.advance(30 * 60_000);
    const again = await reconcileOnce({ store, tenants: () => listed(tenants), clock: clock.now });
    expect(again).toMatchObject({ enqueued: 0, duplicate: 2 });

    clock.advance(30 * 60_000);
    const next = await reconcileOnce({ store, tenants: () => listed(tenants), clock: clock.now });
    expect(next).toMatchObject({ enqueued: 2, duplicate: 0, skipped: 2 });
    expect(await queued(active)).toEqual([
      `reconcile:${bindings.get(active) ?? ''}:2026-11-16T10|null`,
      `reconcile:${bindings.get(active) ?? ''}:2026-11-16T11|null`,
    ]);
  });

  it('skips projects where git sync is off', async () => {
    const clock = fakeClock();
    const seeded = await seed();
    value(await storeOver(db).createBinding(seeded.tenant, BINDING));
    const closed: GitSyncGate = { check: () => Promise.resolve('git_sync.not_entitled') };
    const report = await reconcileOnce({
      store: storeOver(db, { clock, gate: closed }),
      tenants: () => listed([seeded.tenant]),
      clock: clock.now,
    });
    expect(report).toMatchObject({ enqueued: 0, skipped: 1 });
    expect(await queued(seeded)).toEqual([]);
  });
});
