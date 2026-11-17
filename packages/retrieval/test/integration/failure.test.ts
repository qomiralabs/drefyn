import { spawn } from 'node:child_process';
import { closeDatabase, type Database, type PublishedDatabase } from '@drefyn/db';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  admin,
  bodies,
  database,
  openApp,
  openReader,
  retrievalOver,
  seedPages,
  seedTenants,
  useDatabase,
  type Seeded,
} from '../support/fixture.ts';
import { describeWithStack } from '../support/presence.ts';
import { migratedDatabase } from '../support/global-setup.ts';
import { capturedLogger } from '../support/scripted.ts';
import { composeArgs } from '../support/stack.ts';

describeWithStack('failure behaviour', () => {
  let app: Database;
  let reader: PublishedDatabase;
  let seeded: Seeded;
  let drop: () => Promise<string>;

  beforeAll(async () => {
    // The timeout case locks a table, which would stall every other file on a shared database.
    const mine = await migratedDatabase('drefyn_retrievalfail');
    drop = mine.drop;
    useDatabase(mine.name);
    app = await openApp();
    reader = await openReader();
    [seeded] = (await seedTenants([1])) as [Seeded];
    await seedPages(app, seeded, bodies('fail', ['slow text', 'other text']));
  });

  afterAll(async () => {
    await closeDatabase(reader);
    await closeDatabase(app);
    useDatabase(null);
    await drop();
  });

  it('a statement past its timeout is busy, with no partial result', async () => {
    // The superuser holds the totals table so the read waits on it until the timeout.
    const holder = spawn('docker', [
      ...composeArgs(),
      'exec',
      '-T',
      'postgres',
      'psql',
      '--no-psqlrc',
      '-qAt',
      '-U',
      'postgres',
      '-d',
      database(),
      '-c',
      'begin; lock table app.published_project_term_totals in access exclusive mode; select pg_sleep(5); commit;',
    ]);
    const finished = new Promise<void>((resolve) =>
      holder.on('close', () => {
        resolve();
      }),
    );
    try {
      for (let tries = 0; tries < 100; tries += 1) {
        const held = await admin(`
select count(*) from pg_locks l join pg_class c on c.oid = l.relation
 where c.relname = 'published_project_term_totals' and l.mode = 'AccessExclusiveLock' and l.granted;`);
        if (Number(held) > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const log = capturedLogger();
      const retrieval = retrievalOver(reader, { config: { timeoutMs: 300 }, logger: log.logger });
      const started = performance.now();
      expect(await retrieval.retrieve(seeded.tenant, { query: 'slow' })).toEqual({
        ok: false,
        error: 'retrieval.busy',
      });
      expect(performance.now() - started).toBeLessThan(4000);
      expect(log.lines.find((l) => l.level === 'warn')?.fields).toMatchObject({
        code: 'retrieval.busy',
        organizationId: seeded.tenant.organizationId,
      });
    } finally {
      await finished;
    }
    // Once the lock is gone the same retrieval answers.
    expect((await retrievalOver(reader).retrieve(seeded.tenant, { query: 'slow' })).ok).toBe(true);
  });

  it('a database that is gone is unavailable', async () => {
    const closed = await openReader();
    await closeDatabase(closed);
    const retrieval = retrievalOver(closed);
    expect(await retrieval.retrieve(seeded.tenant, { query: 'slow' })).toEqual({
      ok: false,
      error: 'retrieval.unavailable',
    });
    expect(await retrieval.getPage(seeded.tenant, { path: '/fail-0' })).toEqual({
      ok: false,
      error: 'retrieval.unavailable',
    });
  });
});
