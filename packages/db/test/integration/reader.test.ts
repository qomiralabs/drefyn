import { organizationId, projectId, type OrganizationRef, type TenantRef } from '@drefyn/tenancy';
import { sql } from 'kysely';
import { beforeAll, expect, it } from 'vitest';
import { withPublishedReader, type PublishedDatabase } from '../../src/index.ts';
import type { DbError } from '../../src/errors.ts';
import { rejected } from '../support.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { query } from './support/sql.ts';
import { superuser } from './support/stack.ts';
import {
  failure,
  fixtureTemplate,
  one,
  pools,
  rawSession,
  rows,
  seed,
  seedProject,
} from './support/tenancy.ts';

const dbs = databases();
const fixture = fixtureTemplate(dbs);
const open = pools();

const ORG_A = organizationId('01a14984-4476-77ce-9335-30000000000a');
const ORG_B = organizationId('01a14984-4476-77ce-9335-30000000000b');
const PRJ_A1 = projectId('01a14984-4476-77ce-9335-3000000000a1');
const PRJ_A2 = projectId('01a14984-4476-77ce-9335-3000000000a2');
const PRJ_B1 = projectId('01a14984-4476-77ce-9335-3000000000b1');
const A1: TenantRef = { organizationId: ORG_A, projectId: PRJ_A1 };
const A2: TenantRef = { organizationId: ORG_A, projectId: PRJ_A2 };
const B1: TenantRef = { organizationId: ORG_B, projectId: PRJ_B1 };

const published = (org: string, project: string, body: string) => ({
  text: 'insert into app.fixture_published (organization_id, project_id, body) values ($1, $2, $3)',
  values: [org, project, body],
});
const draft = (org: string, project: string, body: string) => ({
  text: 'insert into app.fixture_drafts (organization_id, project_id, body) values ($1, $2, $3)',
  values: [org, project, body],
});

const publishedBodies = sql<{ body: string }>`select body from app.fixture_published order by body`;

let db: TestDatabase;
let reader: PublishedDatabase;

// Runs statements as the reader in one transaction with the given settings.
async function asReader(
  settings: { org?: string; project?: string },
  statement: string,
): Promise<{ rows?: unknown[]; code?: string | undefined; message?: string; routine?: string }> {
  const client = await rawSession('reader', db.name);
  try {
    await client.query('begin');
    if (settings.org !== undefined) {
      await client.query("select set_config('drefyn.organization_id', $1, true)", [settings.org]);
    }
    if (settings.project !== undefined) {
      await client.query("select set_config('drefyn.project_id', $1, true)", [settings.project]);
    }
    const result = await client.query(statement);
    await client.query('rollback');
    return { rows: result.rows };
  } catch (error) {
    return failure(error);
  } finally {
    await client.end();
  }
}

describeWithStack('drefyn_public_reader', () => {
  beforeAll(async () => {
    db = await fixture();
    for (const [org, project] of [
      [ORG_A, PRJ_A1],
      [ORG_A, PRJ_A2],
      [ORG_B, PRJ_B1],
    ] as const) {
      await seedProject(db.app, org, project);
      await seed(db.app, org, project, [
        published(org, project, `published ${project.slice(-2)}`),
        draft(org, project, `draft ${project.slice(-2)}`),
      ]);
    }
    reader = await open.reader(db.reader);
  });

  it('gets permission denied on a draft table, even with full context', async () => {
    const result = await asReader(
      { org: ORG_A, project: PRJ_A1 },
      'select * from app.fixture_drafts',
    );
    expect(result.code).toBe('42501');
    expect(result.message).toMatch(/permission denied for table fixture_drafts/);
    // Same SQLSTATE as a policy failure, told apart by the routine.
    expect(result.routine).not.toBe('ExecWithCheckOptions');
  });

  it.each([
    'fixture_notes',
    'fixture_projects',
    'fixture_members',
    'pgmigrations',
    'migration_checksums',
  ])('gets permission denied on app.%s', async (table) => {
    const result = await asReader({ org: ORG_A, project: PRJ_A1 }, `select * from app.${table}`);
    expect(result.code).toBe('42501');
  });

  it('sees zero published rows with no context', async () => {
    expect(await asReader({}, 'select body from app.fixture_published')).toEqual({ rows: [] });
  });

  // tenant_isolation is to drefyn_app only, so it cannot widen the reader to every project.
  it('sees zero published rows with an organization but no project, though A has rows in two projects', async () => {
    expect(
      (
        await superuser(
          `select count(distinct project_id) from app.fixture_published where organization_id = '${ORG_A}';`,
          db.name,
        )
      ).trim(),
    ).toBe('2');
    expect(await asReader({ org: ORG_A }, 'select body from app.fixture_published')).toEqual({
      rows: [],
    });
    expect(
      await asReader({ org: ORG_A, project: '' }, 'select body from app.fixture_published'),
    ).toEqual({ rows: [] });
  });

  it('sees only its project with full context', async () => {
    expect(
      await asReader({ org: ORG_A, project: PRJ_A1 }, 'select body from app.fixture_published'),
    ).toEqual({
      rows: [{ body: 'published a1' }],
    });
  });

  // The owner matches no policy, so under FORCE it sees no tenant rows even with context.
  it('leaves the owner with zero rows even with full context', async () => {
    const client = await rawSession('owner', db.name);
    try {
      await client.query('begin');
      await client.query("select set_config('drefyn.organization_id', $1, true)", [ORG_A]);
      await client.query("select set_config('drefyn.project_id', $1, true)", [PRJ_A1]);
      for (const table of ['fixture_published', 'fixture_drafts', 'fixture_projects']) {
        const { rows } = await client.query<{ n: number }>(
          `select count(*)::int as n from app.${table}`,
        );
        expect(rows, table).toEqual([{ n: 0 }]);
      }
      await client.query('rollback');
    } finally {
      await client.end();
    }
  });

  it('sees nothing with a project that belongs to another organization', async () => {
    expect(
      await asReader({ org: ORG_A, project: PRJ_B1 }, 'select body from app.fixture_published'),
    ).toEqual({ rows: [] });
  });

  it.each([
    [
      "insert into app.fixture_published (organization_id, project_id, body) values ('01a14984-4476-77ce-9335-30000000000a', '01a14984-4476-77ce-9335-3000000000a1', 'x')",
    ],
    ["update app.fixture_published set body = 'x'"],
    ['delete from app.fixture_published'],
    ['truncate app.fixture_published'],
    [
      "insert into app.fixture_drafts (organization_id, project_id, body) values ('01a14984-4476-77ce-9335-30000000000a', '01a14984-4476-77ce-9335-3000000000a1', 'x')",
    ],
  ])('gets permission denied on the write %s', async (statement) => {
    const result = await asReader({ org: ORG_A, project: PRJ_A1 }, statement);
    expect(result.code).toBe('42501');
    expect(result.message).toMatch(/permission denied/);
  });

  it('cannot use a sequence or call anything but the two context readers in app', async () => {
    const callable = await query<{ fn: string }>(
      db.owner,
      `select 'app.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn from pg_proc p
        where p.pronamespace = 'app'::regnamespace
          and has_function_privilege('drefyn_public_reader', p.oid, 'EXECUTE')
        order by 1`,
    );
    expect(callable.map((c) => c.fn)).toEqual(['app.current_org()', 'app.current_project()']);
    const sequences = await query(
      db.owner,
      `select c.relname from pg_class c
        where c.relnamespace = 'app'::regnamespace and c.relkind = 'S'
          and case when c.relkind = 'S'
                then has_sequence_privilege('drefyn_public_reader', c.oid, 'USAGE, SELECT, UPDATE')
                else false end`,
    );
    expect(sequences).toEqual([]);
  });
});

describeWithStack('withPublishedReader', () => {
  beforeAll(async () => {
    db = await fixture();
    for (const [org, project] of [
      [ORG_A, PRJ_A1],
      [ORG_A, PRJ_A2],
      [ORG_B, PRJ_B1],
    ] as const) {
      await seedProject(db.app, org, project);
      await seed(db.app, org, project, [published(org, project, `published ${project.slice(-2)}`)]);
    }
    reader = await open.reader(db.reader);
  });

  it('reads only the published rows of its project', async () => {
    expect(await withPublishedReader(reader, A1, (tx) => rows(tx, publishedBodies))).toEqual([
      { body: 'published a1' },
    ]);
    expect(await withPublishedReader(reader, A2, (tx) => rows(tx, publishedBodies))).toEqual([
      { body: 'published a2' },
    ]);
    expect(await withPublishedReader(reader, B1, (tx) => rows(tx, publishedBodies))).toEqual([
      { body: 'published b1' },
    ]);
  });

  it('connects as drefyn_public_reader with both settings and a 2 s timeout', async () => {
    const state = await withPublishedReader(reader, A1, (tx) =>
      one(
        tx,
        sql<{ who: string; org: string | null; project: string | null; timeout: string }>`
          select current_user::text as who, app.current_org()::text as org,
                 app.current_project()::text as project, current_setting('statement_timeout') as timeout`,
      ),
    );
    expect(state).toEqual({
      who: 'drefyn_public_reader',
      org: ORG_A,
      project: PRJ_A1,
      timeout: '2s',
    });
  });

  it('is refused on a draft table', async () => {
    const error = await rejected(
      withPublishedReader(reader, A1, (tx) => rows(tx, sql`select * from app.fixture_drafts`)),
    );
    expect(failure(error)).toMatchObject({ code: '42501' });
    expect(failure(error).message).toMatch(/permission denied/);
  });

  it('is refused on a write', async () => {
    const error = await rejected(
      withPublishedReader(reader, A1, (tx) =>
        sql`update app.fixture_published set body = 'defaced'`.execute(tx),
      ),
    );
    expect(failure(error).code).toMatch(/^(42501|25006)$/);
    expect(await withPublishedReader(reader, A1, (tx) => rows(tx, publishedBodies))).toEqual([
      { body: 'published a1' },
    ]);
  });

  // The read only transaction is what stops this write: the reader holds an UPDATE grant on
  // this table on purpose, so permissions alone would let it through.
  it('refuses a write the reader holds a grant for, since the transaction is read only', async () => {
    await query(db.owner, 'create table app.reader_scratch (id int)');
    await query(db.owner, 'grant select, update on app.reader_scratch to drefyn_public_reader');
    try {
      const error = await rejected(
        withPublishedReader(reader, A1, (tx) =>
          sql`update app.reader_scratch set id = 1`.execute(tx),
        ),
      );
      expect(failure(error).code).toBe('25006');
    } finally {
      await query(db.owner, 'drop table app.reader_scratch');
    }
  });

  it.each<[string, unknown]>([
    ['an OrganizationRef', { organizationId: ORG_A } satisfies OrganizationRef],
    ['an empty project', { organizationId: ORG_A, projectId: '' }],
    ['no organization', { projectId: PRJ_A1 }],
  ])('refuses %s with DB_TENANT_CONTEXT_MISSING', async (_label, ctx) => {
    let ran = false;
    const error = await rejected(
      withPublishedReader(reader, ctx as TenantRef, () => {
        ran = true;
        return Promise.resolve(1);
      }),
    );
    expect((error as DbError).code).toBe('DB_TENANT_CONTEXT_MISSING');
    expect(ran).toBe(false);
  });

  it.each([0, 10_001, 60_000])('refuses a timeout of %s before running anything', async (ms) => {
    let ran = false;
    const error = await rejected(
      withPublishedReader(
        reader,
        A1,
        () => {
          ran = true;
          return Promise.resolve(1);
        },
        { timeoutMs: ms },
      ),
    );
    expect((error as DbError).code).toBe('DB_CONFIG_INVALID');
    expect(ran).toBe(false);
  });

  it('takes a timeout up to 10 s', async () => {
    const timeout = sql<{ statement_timeout: string }>`show statement_timeout`;
    expect(
      await withPublishedReader(reader, A1, (tx) => one(tx, timeout), { timeoutMs: 10_000 }),
    ).toEqual({ statement_timeout: '10s' });
  });

  it('times out with DB_TIMEOUT', async () => {
    const error = await rejected(
      withPublishedReader(reader, A1, (tx) => sql`select pg_sleep(30)`.execute(tx), {
        timeoutMs: 50,
      }),
    );
    expect((error as DbError).code).toBe('DB_TIMEOUT');
  });
});
