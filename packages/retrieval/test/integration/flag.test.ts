import { closeDatabase, type Database, type PublishedDatabase } from '@drefyn/db';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  bodies,
  FLAG_OFF,
  FLAG_ON,
  openApp,
  openReader,
  retrievalOver,
  seedPages,
  seedTenants,
  type Seeded,
  type SeededPage,
} from '../support/fixture.ts';
import { describeWithStack } from '../support/presence.ts';
import { capturedLogger } from '../support/scripted.ts';

describeWithStack('the retrieval.v1 flag', () => {
  let app: Database;
  let reader: PublishedDatabase;
  let seeded: Seeded;
  let page: SeededPage;

  beforeAll(async () => {
    app = await openApp();
    reader = await openReader();
    [seeded] = (await seedTenants([1])) as [Seeded];
    [page] = (await seedPages(app, seeded, bodies('flag', ['flagged text']))) as [SeededPage];
  });

  afterAll(async () => {
    await closeDatabase(reader);
    await closeDatabase(app);
  });

  it('on: every call answers from Postgres', async () => {
    const retrieval = retrievalOver(reader, { flags: FLAG_ON });
    expect((await retrieval.retrieve(seeded.tenant, { query: 'flagged' })).ok).toBe(true);
    expect((await retrieval.retrieveScored(seeded.tenant, { query: 'flagged' })).ok).toBe(true);
    expect((await retrieval.getPage(seeded.tenant, { nodeId: page.nodeId })).ok).toBe(true);
    expect((await retrieval.listVersions(seeded.tenant)).ok).toBe(true);
  });

  it('off: every call is not_found, as if the feature did not exist', async () => {
    const log = capturedLogger();
    const retrieval = retrievalOver(reader, { flags: FLAG_OFF, logger: log.logger });
    const notFound = { ok: false, error: 'retrieval.not_found' };
    expect(await retrieval.retrieve(seeded.tenant, { query: 'flagged' })).toEqual(notFound);
    expect(await retrieval.retrieveScored(seeded.tenant, { query: 'flagged' })).toEqual(notFound);
    expect(await retrieval.getPage(seeded.tenant, { nodeId: page.nodeId })).toEqual(notFound);
    expect(await retrieval.listVersions(seeded.tenant)).toEqual(notFound);
    expect(log.lines.every((l) => l.fields['outcome'] === 'retrieval.not_found')).toBe(true);
  });

  it('a flag that cannot be read fails closed', async () => {
    const retrieval = retrievalOver(reader, {
      flags: { evaluate: () => Promise.reject(new Error('flagd down')) },
    });
    expect(await retrieval.retrieve(seeded.tenant, { query: 'flagged' })).toEqual({
      ok: false,
      error: 'retrieval.unavailable',
    });
  });
});
