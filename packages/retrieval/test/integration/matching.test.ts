import { closeDatabase, type Database, type PublishedDatabase } from '@drefyn/db';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Retrieval } from '../../src/index.ts';
import {
  bodies,
  chunkIdOf,
  openApp,
  openReader,
  retrievalOver,
  seedPages,
  seedTenants,
  type Seeded,
  type SeededPage,
} from '../support/fixture.ts';
import { describeWithStack } from '../support/presence.ts';

describeWithStack('matching', () => {
  let app: Database;
  let reader: PublishedDatabase;
  let retrieval: Retrieval;
  let seeded: Seeded;
  let pages: SeededPage[];

  beforeAll(async () => {
    app = await openApp();
    reader = await openReader();
    retrieval = retrievalOver(reader);
    [seeded] = (await seedTenants([1])) as [Seeded];
    pages = await seedPages(app, seeded, [
      ...bodies('match', [
        'header',
        'Footers sit at the bottom of every page.',
        'Sidebars list the sections of a guide.',
      ]),
      {
        slug: 'guides',
        versions: [{ state: 'current', chunks: [{ heading: ['Headers'], body: 'Configure it.' }] }],
      },
    ]);
  });

  afterAll(async () => {
    await closeDatabase(reader);
    await closeDatabase(app);
  });

  it('a natural question matches on any of its words', async () => {
    const result = await retrieval.retrieve(seeded.tenant, { query: 'how do I add a header' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hits[0]?.chunkId).toBe(chunkIdOf(pages[0]));
    expect(result.value.hits[0]?.text).toBe('header');
  });

  it('the heading is part of what matches', async () => {
    const result = await retrieval.retrieve(seeded.tenant, { query: 'where are the headers?' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.hits.map((h) => h.chunkId)).toContain(chunkIdOf(pages[3]));
  });

  it('case and punctuation do not matter', async () => {
    const result = await retrieval.retrieve(seeded.tenant, { query: 'FOOTERS!!!' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.hits[0]?.chunkId).toBe(chunkIdOf(pages[1]));
  });

  it('a path prefix keeps hits under that path only', async () => {
    const all = await retrieval.retrieve(seeded.tenant, { query: 'header headers' });
    expect(all.ok && all.value.hits.length).toBe(2);
    const under = await retrieval.retrieve(seeded.tenant, {
      query: 'header headers',
      pathPrefix: '/guides',
    });
    expect(under.ok).toBe(true);
    if (under.ok) expect(under.value.hits.map((h) => h.path)).toEqual(['/guides']);
    const notASibling = await retrieval.retrieve(seeded.tenant, {
      query: 'header headers',
      pathPrefix: '/guide',
    });
    expect(notASibling).toMatchObject({ ok: true, value: { hits: [] } });
    const root = await retrieval.retrieve(seeded.tenant, {
      query: 'header headers',
      pathPrefix: '/',
    });
    expect(root.ok && root.value.hits.length).toBe(2);
  });

  it('the limit caps the hits and ranks stay 1 based', async () => {
    const result = await retrieval.retrieve(seeded.tenant, {
      query: 'header footers sidebars headers',
      limit: 2,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.hits.map((h) => h.rank)).toEqual([1, 2]);
  });

  it('a question with no word in the docs has no hits', async () => {
    expect(
      await retrieval.retrieve(seeded.tenant, { query: 'quantum entanglement' }),
    ).toMatchObject({
      ok: true,
      value: { hits: [] },
    });
  });
});
