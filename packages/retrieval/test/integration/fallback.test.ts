import { closeDatabase, type Database, type PublishedDatabase } from '@drefyn/db';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  openApp,
  openReader,
  retrievalOver,
  seedPages,
  seedTenants,
  bodies,
  type Seeded,
} from '../support/fixture.ts';
import { describeWithStack } from '../support/presence.ts';

describeWithStack('ranking without embeddings', () => {
  let app: Database;
  let reader: PublishedDatabase;
  let seeded: Seeded;

  beforeAll(async () => {
    app = await openApp();
    reader = await openReader();
    [seeded] = (await seedTenants([1])) as [Seeded];
    await seedPages(app, seeded, bodies('fallback', ['rotate the signing key', 'list keys']));
  });

  afterAll(async () => {
    await closeDatabase(reader);
    await closeDatabase(app);
  });

  it('is lexical, says so, and still answers', async () => {
    const retrieval = retrievalOver(reader);
    const plain = await retrieval.retrieve(seeded.tenant, { query: 'rotate key' });
    const scored = await retrieval.retrieveScored(seeded.tenant, { query: 'rotate key' });
    for (const result of [plain, scored]) {
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.ranking).toBe('lexical');
      expect(result.value.hits.length).toBeGreaterThan(0);
    }
  });

  it('is lexical with no hits too', async () => {
    const result = await retrievalOver(reader).retrieve(seeded.tenant, { query: 'nothing' });
    expect(result).toMatchObject({ ok: true, value: { ranking: 'lexical', hits: [] } });
  });
});
