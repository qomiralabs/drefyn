import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  createDeliveryLedger,
  createInstallationStore,
  DELIVERY_RETENTION_MS,
} from '../../src/index.ts';
import { admin, pools, seed } from '../support/fixture.ts';
import { describeWithStack } from '../support/presence.ts';

const open = pools();
const digest = (text: string) => new Uint8Array(createHash('sha256').update(text).digest());

describeWithStack('the installation store', () => {
  it('records, reads, suspends, updates and removes an installation', async () => {
    const store = createInstallationStore({ db: await open() });
    const [tenant] = await seed();
    if (tenant === undefined) throw new Error('seed');
    const recorded = await store.record(tenant, {
      installationId: 9_007_199_254_740_991,
      accountId: 55,
      repositoryIds: [4001],
    });
    expect(recorded).toEqual({
      tenant,
      installationId: 9_007_199_254_740_991,
      accountId: 55,
      repositoryIds: [4001],
      suspended: false,
    });
    expect(await store.get(tenant, 9_007_199_254_740_991)).toEqual(recorded);
    expect(await store.setSuspended(tenant, 9_007_199_254_740_991, true)).toBe(true);
    expect((await store.get(tenant, 9_007_199_254_740_991))?.suspended).toBe(true);
    // Recording again replaces the repositories and lifts nothing: suspension is GitHub's call.
    const again = await store.record(tenant, {
      installationId: 9_007_199_254_740_991,
      accountId: 55,
      repositoryIds: [4002, 4001],
    });
    expect(again.repositoryIds).toEqual([4001, 4002]);
    expect(again.suspended).toBe(true);
    expect(await store.setSuspended(tenant, 9_007_199_254_740_991, false)).toBe(true);
    expect(await store.remove(tenant, 9_007_199_254_740_991)).toBe(true);
    expect(await store.get(tenant, 9_007_199_254_740_991)).toBeNull();
    expect(await store.remove(tenant, 9_007_199_254_740_991)).toBe(false);
  });

  it.each([
    ['no repositories', { installationId: 1, accountId: 1, repositoryIds: [] }],
    [
      '101 repositories',
      {
        installationId: 1,
        accountId: 1,
        repositoryIds: Array.from({ length: 101 }, (_, i) => i + 1),
      },
    ],
    ['a repeated repository', { installationId: 1, accountId: 1, repositoryIds: [5, 5] }],
    ['an installation id of zero', { installationId: 0, accountId: 1, repositoryIds: [1] }],
    ['an unsafe account id', { installationId: 1, accountId: 2 ** 53, repositoryIds: [1] }],
  ])('refuses %s before touching the database', async (_name, input) => {
    const store = createInstallationStore({ db: await open() });
    const [tenant] = await seed();
    if (tenant === undefined) throw new Error('seed');
    await expect(store.record(tenant, input)).rejects.toThrow(TypeError);
  });
});

describeWithStack('the delivery ledger', () => {
  it('takes a delivery once, by id and by body', async () => {
    const ledger = createDeliveryLedger({ db: await open() });
    const id = randomUUID();
    const body = digest(id);
    expect(await ledger.claim({ deliveryId: id, bodySha256: body, event: 'push' })).toBe('new');
    expect(
      await ledger.claim({ deliveryId: id, bodySha256: digest('x' + id), event: 'push' }),
    ).toBe('replayed');
    expect(await ledger.claim({ deliveryId: randomUUID(), bodySha256: body, event: 'push' })).toBe(
      'replayed',
    );
  });

  it('forgets a released delivery so GitHub can send it again', async () => {
    const ledger = createDeliveryLedger({ db: await open() });
    const id = randomUUID();
    const claim = { deliveryId: id, bodySha256: digest(id), event: 'installation' };
    expect(await ledger.claim(claim)).toBe('new');
    await ledger.release(id);
    expect(await ledger.claim(claim)).toBe('new');
  });

  it('lets only one of many concurrent claims win', async () => {
    const ledger = createDeliveryLedger({ db: await open() });
    const id = randomUUID();
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        ledger.claim({ deliveryId: id, bodySha256: digest(id), event: 'push' }),
      ),
    );
    expect(outcomes.filter((o) => o === 'new')).toHaveLength(1);
  });

  it('drops rows past the retention a little at a time', async () => {
    const db = await open();
    const old = randomUUID();
    await admin(
      `insert into app.github_webhook_deliveries (delivery_id, body_sha256, event, received_at)
         values ('${old}', decode(md5('${old}') || md5('${old}'), 'hex'), 'push',
                 now() - interval '${String(DELIVERY_RETENTION_MS / 1000 + 60)} seconds');`,
    );
    const ledger = createDeliveryLedger({ db });
    const fresh = randomUUID();
    await ledger.claim({ deliveryId: fresh, bodySha256: digest(fresh), event: 'push' });
    expect(
      await admin(
        `select count(*) from app.github_webhook_deliveries where delivery_id = '${old}';`,
      ),
    ).toBe('0');
  });

  it('refuses a claim that is not shaped like a GitHub delivery', async () => {
    const ledger = createDeliveryLedger({ db: await open() });
    await expect(
      ledger.claim({ deliveryId: 'nope', bodySha256: digest('a'), event: 'push' }),
    ).rejects.toThrow(TypeError);
    await expect(
      ledger.claim({ deliveryId: randomUUID(), bodySha256: new Uint8Array(3), event: 'push' }),
    ).rejects.toThrow(TypeError);
    await expect(
      ledger.claim({ deliveryId: randomUUID(), bodySha256: digest('a'), event: 'Push!' }),
    ).rejects.toThrow(TypeError);
  });
});
