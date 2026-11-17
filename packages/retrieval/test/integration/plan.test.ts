import {
  closeDatabase,
  withPublishedReader,
  type Database,
  type PublishedDatabase,
} from '@drefyn/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DEFAULT_RETRIEVAL_CONFIG, publishedReader } from '../../src/index.ts';
import { prepareRead, searchStatement } from '../../src/statement.ts';
import {
  admin,
  bodies,
  openApp,
  openReader,
  retrievalOver,
  seedPages,
  seedTenants,
  type Seeded,
} from '../support/fixture.ts';
import { describeWithStack } from '../support/presence.ts';

interface PlanNode {
  readonly 'Node Type'?: string;
  readonly 'Relation Name'?: string;
  readonly 'Index Name'?: string;
  readonly Plans?: readonly PlanNode[];
}

const nodes = (plan: PlanNode): PlanNode[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];

describeWithStack('the read transaction and its plan', () => {
  let app: Database;
  let reader: PublishedDatabase;
  let seeded: Seeded;

  beforeAll(async () => {
    app = await openApp();
    // One connection, so the later read is on the same session as the retrieval.
    reader = await openReader(1);
    const [first, ...others] = await seedTenants([1, 1, 1]);
    seeded = first as Seeded;
    // Enough postings that the planner has a real choice to make. "every" is in all chunks,
    // so it scores by probe; each chunk also has words shared by a few others.
    const texts = (prefix: string) =>
      Array.from(
        { length: 400 },
        (_, n) =>
          `every chunk word${String(n % 37)} word${String(n % 11)} ${prefix}${String(n)} text`,
      );
    await seedPages(app, seeded, bodies('plan', texts('own')));
    for (const other of others) await seedPages(app, other, bodies('plan', texts('other')));
    await admin('vacuum (analyze) app.published_chunk_terms;');
    await admin('vacuum (analyze) app.published_term_stats;');
    await admin('vacuum (analyze) app.published_project_term_totals;');
    await admin('vacuum (analyze) app.published_chunks;');
  });

  afterAll(async () => {
    await closeDatabase(reader);
    await closeDatabase(app);
  });

  it('sets the plan mode and the timeout for the read only', async () => {
    const inside = await publishedReader(reader).read(seeded.tenant, 1500, async (tx) => {
      await prepareRead(tx, 1234);
      const { rows } = await sql<{ mode: string; timeout: string; pid: number }>`
        select current_setting('plan_cache_mode') as mode,
               current_setting('statement_timeout') as timeout,
               pg_backend_pid() as pid`.execute(tx);
      return rows[0];
    });
    expect(inside).toMatchObject({ mode: 'force_custom_plan', timeout: '1234ms' });
    const retrieval = retrievalOver(reader);
    expect((await retrieval.retrieve(seeded.tenant, { query: 'every word3' })).ok).toBe(true);
    const after = await withPublishedReader(reader, seeded.tenant, async (tx) => {
      const { rows } = await sql<{ mode: string; pid: number }>`
        select current_setting('plan_cache_mode') as mode, pg_backend_pid() as pid`.execute(tx);
      return rows[0];
    });
    expect(after?.pid).toBe(inside?.pid);
    expect(after?.mode).toBe('auto');
  });

  it('reads postings with index only scans, and probes by the primary key', async () => {
    const plan = await publishedReader(reader).read(seeded.tenant, 10_000, async (tx) => {
      await prepareRead(tx, 10_000);
      const statement = searchStatement(seeded.tenant, {
        label: 'latest',
        query: 'every word3 own7',
        limit: 8,
        pathPrefix: null,
        scored: true,
        caps: DEFAULT_RETRIEVAL_CONFIG,
      });
      const { rows } = await sql<{ 'QUERY PLAN': { Plan: PlanNode }[] }>`
        explain (format json, costs off) ${statement}`.execute(tx);
      return rows[0]?.['QUERY PLAN'][0]?.Plan;
    });
    expect(plan).toBeDefined();
    const all = nodes(plan ?? {});
    const onPostings = all.filter((n) => n['Relation Name'] === 'published_chunk_terms');
    expect(onPostings.length).toBeGreaterThan(0);
    for (const node of onPostings) expect(node['Node Type']).toBe('Index Only Scan');
    const indexes = new Set(onPostings.map((n) => n['Index Name']));
    expect(indexes).toContain('published_chunk_terms_pkey');
    expect(indexes).toContain('published_chunk_terms_impact');
    expect(all.some((n) => n['Node Type'] === 'Seq Scan')).toBe(false);
  });
});
