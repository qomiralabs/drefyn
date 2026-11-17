import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import fc from 'fast-check';
import { sql } from 'kysely';
import { beforeAll, expect, it } from 'vitest';
import {
  withProtectedReader,
  withPublishedReader,
  withTenant,
  type Database,
  type ProtectedReaderDatabase,
  type PublishedDatabase,
} from '../../src/index.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import {
  chunkSql,
  seed,
  seedTenant,
  seedTenantsSql,
  type SeedTenant,
} from './support/published-chunks.ts';
import { superuser } from './support/stack.ts';
import { pools, protectedUrl, rawSession, rows } from './support/tenancy.ts';

const dbs = databases();
const open = pools();

const A1 = seedTenant(62, 1);
// A second project of the same organization, which must stay as invisible as another org.
const A2: SeedTenant = { ...seedTenant(62, 2), org: A1.org };
const B1 = seedTenant(62, 3);
const TENANTS = [A1, A2, B1] as const;

const ref = (t: SeedTenant): TenantRef => ({
  organizationId: organizationId(t.org),
  projectId: projectId(t.project),
});

const label = (t: SeedTenant) => t.project.slice(-4);

// A public and a protected chunk per tenant, each naming itself, plus the term rows publish
// would write for the public one only.
function tenantRows(t: SeedTenant): string {
  return `
${chunkSql(t, { ord: 0, headingPath: [], body: `public ${label(t)}`, visibility: 'public' })}
${chunkSql(t, { ord: 1, headingPath: [], body: `protected ${label(t)}`, visibility: 'protected' })}
insert into app.published_project_term_totals (organization_id, project_id, chunk_count,
    total_length, visibility)
  values ('${t.org}', '${t.project}', 1, 2, 'public');
insert into app.published_term_stats (organization_id, project_id, lexeme, df, visibility)
  values ('${t.org}', '${t.project}', 'public', 1, 'public'),
         ('${t.org}', '${t.project}', '${label(t)}', 1, 'public');
insert into app.published_chunk_terms (organization_id, project_id, lexeme, chunk_id, tf, chunk_length,
    visibility)
  select organization_id, project_id, lexeme, id, 1, 2, 'public'
    from app.published_chunks, unnest(array['public', '${label(t)}']) lexeme
   where project_id = '${t.project}' and visibility = 'public';`;
}

const TERM_TABLES = [
  'published_project_term_totals',
  'published_term_stats',
  'published_chunk_terms',
] as const;

let db: TestDatabase;
let reader: PublishedDatabase;
let protectedReader: ProtectedReaderDatabase;
let app: Database;

const bodies = (handle: PublishedDatabase, tenant: TenantRef, where = sql`true`) =>
  withPublishedReader(handle, tenant, (tx) =>
    rows(
      tx,
      sql<{ body: string }>`select body from app.published_chunks where ${where} order by body`,
    ),
  ).then((found) => found.map((r) => r.body));

const termProjects = (tenant: TenantRef) =>
  withPublishedReader(reader, tenant, async (tx) => {
    const out: Record<string, string[]> = {};
    for (const table of TERM_TABLES) {
      const found = await rows(
        tx,
        sql<{ project: string }>`select distinct project_id::text as project
                                   from ${sql.table(`app.${table}`)} order by 1`,
      );
      out[table] = found.map((r) => r.project);
    }
    return out;
  });

describeWithStack('published chunks and term tables under RLS', () => {
  beforeAll(async () => {
    db = await dbs.fresh('migrated');
    await seed(db.name, [seedTenantsSql(TENANTS), ...TENANTS.map(tenantRows)].join('\n'));
    reader = await open.reader(db.reader);
    protectedReader = await open.protectedReader(protectedUrl(db));
    app = await open.app(db.app);
  });

  it('shows the public reader the public chunks of its own project only', async () => {
    expect(await bodies(reader, ref(A1))).toEqual([`public ${label(A1)}`]);
    expect(await bodies(reader, ref(A2))).toEqual([`public ${label(A2)}`]);
    expect(await bodies(reader, ref(B1))).toEqual([`public ${label(B1)}`]);
  });

  it('never shows a protected chunk, even when a query asks for one by name', async () => {
    for (const t of TENANTS) {
      expect(await bodies(reader, ref(t), sql`visibility = 'protected'`)).toEqual([]);
      expect(await bodies(reader, ref(t), sql`body like 'protected%'`)).toEqual([]);
    }
  });

  it('shows the public reader the term rows of its own project only', async () => {
    for (const t of TENANTS) {
      expect(await termProjects(ref(t))).toEqual({
        published_project_term_totals: [t.project],
        published_term_stats: [t.project],
        published_chunk_terms: [t.project],
      });
    }
  });

  it('shows the public reader nothing with an organization from one tenant and a project from another', async () => {
    const mixed: TenantRef = {
      organizationId: organizationId(B1.org),
      projectId: projectId(A1.project),
    };
    expect(await bodies(reader, mixed)).toEqual([]);
    expect(await termProjects(mixed)).toEqual({
      published_project_term_totals: [],
      published_term_stats: [],
      published_chunk_terms: [],
    });
  });

  it('refuses every write by the public reader', async () => {
    for (const table of ['published_chunks', ...TERM_TABLES]) {
      await expect(
        withPublishedReader(reader, ref(A1), (tx) =>
          sql`delete from ${sql.table(`app.${table}`)}`.execute(tx),
        ),
      ).rejects.toThrow();
    }
    const left = await superuser(`select count(*) from app.published_chunks;`, db.name);
    expect(left.trim()).toBe(String(TENANTS.length * 2));
  });

  it('shows the protected reader both chunks and the term rows of its own project only', async () => {
    for (const t of TENANTS) {
      const seen = await withProtectedReader(protectedReader, { tenant: ref(t) }, async (tx) => {
        const chunks = await rows(
          tx,
          sql<{ body: string }>`select body from app.published_chunks order by body`,
        );
        const terms: Record<string, string[]> = {};
        for (const table of TERM_TABLES) {
          const found = await rows(
            tx,
            sql<{ project: string }>`select distinct project_id::text as project
                                       from ${sql.table(`app.${table}`)} order by 1`,
          );
          terms[table] = found.map((r) => r.project);
        }
        return { chunks: chunks.map((r) => r.body), terms };
      });
      expect(seen).toEqual({
        chunks: [`protected ${label(t)}`, `public ${label(t)}`],
        terms: {
          published_project_term_totals: [t.project],
          published_term_stats: [t.project],
          published_chunk_terms: [t.project],
        },
      });
    }
  });

  it('shows drefyn_app nothing without tenant context', async () => {
    const client = await rawSession('app', db.name);
    try {
      for (const table of ['published_chunks', ...TERM_TABLES]) {
        const found = await client.query<{ n: string }>(
          `select count(*)::text as n from app.${table}`,
        );
        expect(found.rows, table).toEqual([{ n: '0' }]);
      }
    } finally {
      await client.end();
    }
  });

  it('shows drefyn_app both visibilities of its own tenant, since publish writes both', async () => {
    const found = await withTenant(app, ref(A1), (tx) =>
      rows(tx, sql<{ body: string }>`select body from app.published_chunks order by body`),
    );
    expect(found.map((r) => r.body)).toEqual([`protected ${label(A1)}`, `public ${label(A1)}`]);
  });

  it('never lets the public reader read a protected row or another tenant row, over random rows', async () => {
    let round = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            tenant: fc.constantFrom(0, 1, 2),
            visibility: fc.constantFrom<'public' | 'protected'>('public', 'protected'),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        fc.constantFrom(0, 1, 2),
        async (chunks, viewer) => {
          round += 1;
          const tag = `r${String(round)}`;
          const statements = chunks.map((chunk, at) => {
            const t = TENANTS[chunk.tenant];
            return chunkSql(t, {
              ord: 100 + at,
              headingPath: [],
              body: `${tag} ${String(chunk.tenant)} ${chunk.visibility} ${String(at)}`,
              visibility: chunk.visibility,
            });
          });
          await seed(db.name, statements.join('\n'));
          try {
            const viewerTenant = TENANTS[viewer];
            const seen = await bodies(reader, ref(viewerTenant), sql`body like ${`${tag} %`}`);
            const expected = chunks
              .map((chunk, at) => ({ chunk, at }))
              .filter(({ chunk }) => chunk.tenant === viewer && chunk.visibility === 'public')
              .map(({ chunk, at }) => `${tag} ${String(chunk.tenant)} public ${String(at)}`)
              .sort();
            expect(seen).toEqual(expected);
          } finally {
            await superuser(`delete from app.published_chunks where ord >= 100;`, db.name);
          }
        },
      ),
      { numRuns: 25 },
    );
  });
});
