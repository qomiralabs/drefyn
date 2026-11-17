import { closeDatabase, type Database } from '@drefyn/db';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { appTermStore, createTermRebuild } from '../../src/index.ts';
import {
  admin,
  openApp,
  seedPages,
  seedTenants,
  storedTerms,
  type Seeded,
} from '../support/fixture.ts';
import { describeWithStack } from '../support/presence.ts';
import { recomputedCorpus } from '../support/reference.ts';

// The three tables as storedTerms prints them, computed from the public current text.
async function expectedTerms(app: Database, seeded: Seeded) {
  const corpus = await recomputedCorpus(app, seeded.tenant);
  const postings = [...corpus.postings].flatMap(([lexeme, list]) =>
    list.map((p) => `latest ${lexeme} ${p.chunkId} ${String(p.tf)} ${String(p.length)}`),
  );
  const stats = [...corpus.postings].map(
    ([lexeme, list]) => `latest ${lexeme} ${String(list.length)}`,
  );
  const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    totals:
      corpus.chunkCount === 0
        ? []
        : [`latest ${String(corpus.chunkCount)} ${String(corpus.totalLength)}`],
    stats: stats.sort(byText),
    postings: postings.sort(byText),
  };
}

const sorted = (state: Awaited<ReturnType<typeof storedTerms>>) => {
  const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    totals: [...state.totals].sort(byText),
    stats: [...state.stats].sort(byText),
    postings: [...state.postings].sort(byText),
  };
};

describeWithStack('rebuildTermStats', () => {
  let app: Database;
  let seeded: Seeded;
  let other: Seeded;

  beforeAll(async () => {
    app = await openApp();
    [seeded, other] = (await seedTenants([1, 1])) as [Seeded, Seeded];
    await seedPages(app, seeded, [
      {
        slug: 'public',
        versions: [
          { state: 'current', chunks: [{ heading: ['Keys'], body: 'rotate keys rotate' }] },
        ],
      },
      {
        slug: 'protected',
        versions: [
          { state: 'current', visibility: 'protected', chunks: [{ body: 'rebuildsecret word' }] },
        ],
      },
      {
        slug: 'old',
        versions: [
          { state: 'old', chunks: [{ body: 'rebuildold word' }] },
          { state: 'current', chunks: [{ body: 'fresh word' }] },
        ],
      },
      { slug: 'draft', versions: [{ state: 'draft', chunks: [{ body: 'rebuilddraft word' }] }] },
    ]);
    await seedPages(app, other, [
      { slug: 'other', versions: [{ state: 'current', chunks: [{ body: 'other tenant word' }] }] },
    ]);
  });

  afterAll(async () => {
    await closeDatabase(app);
  });

  it('recomputes the three tables from the public current chunks only', async () => {
    expect(sorted(await storedTerms(app, seeded.tenant))).toEqual(await expectedTerms(app, seeded));
    for (const word of ['rebuildsecret', 'rebuildold', 'rebuilddraft']) {
      const rows = await admin(
        `select (select count(*) from app.published_term_stats where lexeme = '${word}')
              + (select count(*) from app.published_chunk_terms where lexeme = '${word}');`,
      );
      expect(Number(rows)).toBe(0);
    }
  });

  it('repairs drift and is idempotent', async () => {
    const before = await storedTerms(app, other.tenant);
    await admin(`
delete from app.published_chunk_terms
 where organization_id = '${seeded.tenant.organizationId}'
   and project_id = '${seeded.tenant.projectId}' and lexeme = 'rotate';
update app.published_term_stats set df = df + 7
 where organization_id = '${seeded.tenant.organizationId}'
   and project_id = '${seeded.tenant.projectId}';
update app.published_project_term_totals set chunk_count = 99, total_length = 1
 where organization_id = '${seeded.tenant.organizationId}'
   and project_id = '${seeded.tenant.projectId}';`);
    const rebuild = createTermRebuild({ store: appTermStore(app) });
    const first = await rebuild.rebuildTermStats(seeded.tenant);
    const once = await storedTerms(app, seeded.tenant);
    const second = await rebuild.rebuildTermStats(seeded.tenant);
    expect(first).toEqual(second);
    expect(first).toEqual({ ok: true, value: { chunks: 2, lexemes: 4 } });
    expect(await storedTerms(app, seeded.tenant)).toEqual(once);
    expect(sorted(once)).toEqual(await expectedTerms(app, seeded));
    // Another project's rows are untouched.
    expect(await storedTerms(app, other.tenant)).toEqual(before);
  });

  it('an empty project rebuilds to nothing', async () => {
    const [empty] = (await seedTenants([1])) as [Seeded];
    const rebuilt = await createTermRebuild({ store: appTermStore(app) }).rebuildTermStats(
      empty.tenant,
    );
    expect(rebuilt).toEqual({ ok: true, value: { chunks: 0, lexemes: 0 } });
    expect(await storedTerms(app, empty.tenant)).toEqual({ totals: [], stats: [], postings: [] });
  });
});
