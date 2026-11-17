import { withTenant } from '@drefyn/db';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { createInstallationStore } from '../../src/index.ts';
import { admin, pools, seed } from '../support/fixture.ts';
import { describeWithStack } from '../support/presence.ts';

const open = pools();

const input = { installationId: 7001, accountId: 55, repositoryIds: [4001, 4002] };

describeWithStack('installation rows under row level security', () => {
  it('are invisible to another organization, even for the same installation id', async () => {
    const db = await open();
    const store = createInstallationStore({ db });
    const [mine] = await seed();
    const [theirs] = await seed();
    if (mine === undefined || theirs === undefined) throw new Error('seed');
    await store.record(mine, input);
    expect(await store.get(theirs, input.installationId)).toBeNull();
    const counted = await withTenant(db, theirs, (tx) =>
      sql<{ n: string }>`select count(*)::text as n from app.github_installations`.execute(tx),
    );
    expect(counted.rows[0]?.n).toBe('0');
    expect(await store.setSuspended(theirs, input.installationId, true)).toBe(false);
    expect(await store.remove(theirs, input.installationId)).toBe(false);
    expect((await store.get(mine, input.installationId))?.suspended).toBe(false);
  });

  it('are invisible to another project of the same organization', async () => {
    const db = await open();
    const store = createInstallationStore({ db });
    const [one, two] = await seed(2);
    if (one === undefined || two === undefined) throw new Error('seed');
    await store.record(one, input);
    expect(await store.get(two, input.installationId)).toBeNull();
    // The same installation can serve both projects, each with its own row.
    await store.record(two, { ...input, repositoryIds: [4003] });
    expect((await store.get(one, input.installationId))?.repositoryIds).toEqual([4001, 4002]);
    expect((await store.get(two, input.installationId))?.repositoryIds).toEqual([4003]);
  });

  it('cannot be written into another tenant', async () => {
    const db = await open();
    const [mine] = await seed();
    const [theirs] = await seed();
    if (mine === undefined || theirs === undefined) throw new Error('seed');
    await expect(
      withTenant(db, mine, (tx) =>
        sql`insert into app.github_installations
              (organization_id, project_id, installation_id, account_id, repository_ids)
            values (${theirs.organizationId}, ${theirs.projectId}, 7002, 1, '{1}')`.execute(tx),
      ),
    ).rejects.toThrow(/row level security policy refused/);
    expect(
      await admin(
        `select count(*) from app.github_installations where organization_id = '${theirs.organizationId}';`,
      ),
    ).toBe('0');
  });

  it('keeps webhook deliveries out of tenant work entirely', async () => {
    const db = await open();
    const [mine] = await seed();
    if (mine === undefined) throw new Error('seed');
    await admin(
      `insert into app.github_webhook_deliveries (delivery_id, body_sha256, event)
         values (gen_random_uuid(), decode(repeat('ab', 32), 'hex'), 'push')
         on conflict do nothing;`,
    );
    const counted = await withTenant(db, mine, (tx) =>
      sql<{ n: string }>`select count(*)::text as n from app.github_webhook_deliveries`.execute(tx),
    );
    expect(counted.rows[0]?.n).toBe('0');
  });
});
