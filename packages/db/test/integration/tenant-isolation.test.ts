import { organizationId, projectId, type OrganizationRef, type TenantRef } from '@drefyn/tenancy';
import { sql } from 'kysely';
import { beforeAll, expect, it } from 'vitest';
import { withTenant, type Database } from '../../src/index.ts';
import { DbError } from '../../src/errors.ts';
import { rejected } from '../support.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { query } from './support/sql.ts';
import { superuser } from './support/stack.ts';
import {
  context,
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

const ORG_A = organizationId('01a14984-4476-77ce-9335-00000000000a');
const ORG_B = organizationId('01a14984-4476-77ce-9335-00000000000b');
const PRJ_A1 = projectId('01a14984-4476-77ce-9335-0000000000a1');
const PRJ_A2 = projectId('01a14984-4476-77ce-9335-0000000000a2');
const PRJ_B1 = projectId('01a14984-4476-77ce-9335-0000000000b1');
const NOTE_A1 = '01a14984-4476-77ce-9335-00000000a1a1';
const NOTE_A2 = '01a14984-4476-77ce-9335-00000000a2a2';
const NOTE_B1 = '01a14984-4476-77ce-9335-00000000b1b1';

const A: OrganizationRef = { organizationId: ORG_A };
const A1: TenantRef = { organizationId: ORG_A, projectId: PRJ_A1 };
const A2: TenantRef = { organizationId: ORG_A, projectId: PRJ_A2 };
const B: OrganizationRef = { organizationId: ORG_B };
const B1: TenantRef = { organizationId: ORG_B, projectId: PRJ_B1 };

const note = (id: string, org: string, project: string, body: string, slug: string) => ({
  text: 'insert into app.fixture_notes (id, organization_id, project_id, body, slug) values ($1, $2, $3, $4, $5)',
  values: [id, org, project, body, slug],
});

async function seeded(): Promise<TestDatabase> {
  const db = await fixture();
  await seedProject(db.app, ORG_A, PRJ_A1);
  await seedProject(db.app, ORG_A, PRJ_A2);
  await seedProject(db.app, ORG_B, PRJ_B1);
  await seed(db.app, ORG_A, PRJ_A1, [note(NOTE_A1, ORG_A, PRJ_A1, 'a1 note', 'k1')]);
  await seed(db.app, ORG_A, PRJ_A2, [note(NOTE_A2, ORG_A, PRJ_A2, 'a2 note', 'k2')]);
  // The same slug as in A: the unique key includes organization_id, so nothing conflicts.
  await seed(db.app, ORG_B, PRJ_B1, [note(NOTE_B1, ORG_B, PRJ_B1, 'b1 note', 'k1')]);
  await seed(db.app, ORG_A, null, [
    {
      text: "insert into app.fixture_members (organization_id, email) values ($1, 'a@example.test')",
      values: [ORG_A],
    },
  ]);
  await seed(db.app, ORG_B, null, [
    {
      text: "insert into app.fixture_members (organization_id, email) values ($1, 'b@example.test')",
      values: [ORG_B],
    },
  ]);
  return db;
}

const bodies = sql<{ body: string }>`select body from app.fixture_notes order by body`;

let db: TestDatabase;
let app: Database;

describeWithStack('no tenant context on a plain app connection', () => {
  beforeAll(async () => {
    db = await seeded();
  });

  it('selects zero rows from every tenant table', async () => {
    for (const table of [
      'fixture_projects',
      'fixture_notes',
      'fixture_members',
      'fixture_drafts',
      'fixture_published',
    ]) {
      expect(await query(db.app, `select count(*)::int as n from app.${table}`), table).toEqual([
        { n: 0 },
      ]);
    }
  });

  it('cannot insert, and updates and deletes touch nothing', async () => {
    const client = await rawSession('app', db.name);
    try {
      const insert = await rejected(
        client.query(
          'insert into app.fixture_notes (organization_id, project_id, body) values ($1, $2, $3)',
          [ORG_A, PRJ_A1, 'no context'],
        ),
      );
      expect(failure(insert).code).toBe('42501');
      expect(failure(insert).message).toMatch(/row-level security/);
      // What toDbError keys on instead of the text, as PostgreSQL 18.6 reports it.
      expect(failure(insert).routine).toBe('ExecWithCheckOptions');
      expect((await client.query("update app.fixture_notes set body = 'x'")).rowCount).toBe(0);
      expect((await client.query('delete from app.fixture_notes')).rowCount).toBe(0);
      expect((await client.query('delete from app.fixture_projects')).rowCount).toBe(0);
    } finally {
      await client.end();
    }
    // The superuser ignores RLS, so it sees that every seeded row is still there.
    expect((await superuser('select count(*) from app.fixture_notes;', db.name)).trim()).toBe('3');
  });

  // The empty string a finished local setting leaves behind reads as no tenant, not an error.
  it('reports ExecWithCheckOptions for an update that moves a row out of the tenant', async () => {
    const client = await rawSession('app', db.name);
    try {
      await client.query('begin');
      await client.query("select set_config('drefyn.organization_id', $1, true)", [ORG_A]);
      const error = await rejected(
        client.query('update app.fixture_notes set organization_id = $1 where id = $2', [
          ORG_B,
          NOTE_A1,
        ]),
      );
      expect(failure(error)).toMatchObject({ code: '42501', routine: 'ExecWithCheckOptions' });
      await client.query('rollback');
    } finally {
      await client.end();
    }
  });

  it('reads an empty setting as no tenant', async () => {
    const client = await rawSession('app', db.name);
    try {
      await client.query('begin');
      await client.query("select set_config('drefyn.organization_id', '', true)");
      expect((await client.query('select count(*)::int as n from app.fixture_notes')).rows).toEqual(
        [{ n: 0 }],
      );
      await client.query('rollback');
    } finally {
      await client.end();
    }
  });
});

describeWithStack('withTenant scoping', () => {
  beforeAll(async () => {
    db = await seeded();
    app = await open.app(db.app);
  });

  it('sets both settings inside the transaction', async () => {
    expect(await withTenant(app, A1, (tx) => one(tx, context))).toMatchObject({
      org: ORG_A,
      project: PRJ_A1,
    });
    expect(await withTenant(app, A, (tx) => one(tx, context))).toMatchObject({
      org: ORG_A,
      project: null,
    });
  });

  it('returns what the work returns', async () => {
    await expect(withTenant(app, A, () => Promise.resolve({ ok: 1 }))).resolves.toEqual({ ok: 1 });
  });

  it('reads only the project in a project transaction', async () => {
    expect(await withTenant(app, A1, (tx) => rows(tx, bodies))).toEqual([{ body: 'a1 note' }]);
    expect(await withTenant(app, A2, (tx) => rows(tx, bodies))).toEqual([{ body: 'a2 note' }]);
    expect(await withTenant(app, B1, (tx) => rows(tx, bodies))).toEqual([{ body: 'b1 note' }]);
  });

  it('reads every project of the organization and nothing of another in an organization transaction', async () => {
    expect(await withTenant(app, A, (tx) => rows(tx, bodies))).toEqual([
      { body: 'a1 note' },
      { body: 'a2 note' },
    ]);
    expect(await withTenant(app, B, (tx) => rows(tx, bodies))).toEqual([{ body: 'b1 note' }]);
  });

  it('scopes organization tables by organization only', async () => {
    const emails = sql<{ email: string }>`select email from app.fixture_members order by email`;
    expect(await withTenant(app, A1, (tx) => rows(tx, emails))).toEqual([
      { email: 'a@example.test' },
    ]);
    expect(await withTenant(app, B, (tx) => rows(tx, emails))).toEqual([
      { email: 'b@example.test' },
    ]);
  });

  it('cannot read another tenant row by its id', async () => {
    const byId = sql<{ body: string }>`select body from app.fixture_notes where id = ${NOTE_B1}`;
    expect(await withTenant(app, A, (tx) => rows(tx, byId))).toEqual([]);
    const otherProject = sql<{
      body: string;
    }>`select body from app.fixture_notes where id = ${NOTE_A2}`;
    expect(await withTenant(app, A1, (tx) => rows(tx, otherProject))).toEqual([]);
  });

  it('updates and deletes nothing of another organization or project', async () => {
    const touched = await withTenant(app, A, async (tx) => {
      const update =
        await sql`update app.fixture_notes set body = 'hijacked' where id = ${NOTE_B1}`.execute(tx);
      const remove = await sql`delete from app.fixture_notes where id = ${NOTE_B1}`.execute(tx);
      return [update.numAffectedRows, remove.numAffectedRows];
    });
    expect(touched).toEqual([0n, 0n]);
    const fromProject = await withTenant(app, A1, async (tx) => {
      const update =
        await sql`update app.fixture_notes set body = 'hijacked' where id = ${NOTE_A2}`.execute(tx);
      return update.numAffectedRows;
    });
    expect(fromProject).toBe(0n);
    expect(await withTenant(app, B1, (tx) => rows(tx, bodies))).toEqual([{ body: 'b1 note' }]);
    expect(await withTenant(app, A2, (tx) => rows(tx, bodies))).toEqual([{ body: 'a2 note' }]);
  });

  it('refuses to insert a row for another organization', async () => {
    const error = await rejected(
      withTenant(app, A1, (tx) =>
        sql`insert into app.fixture_notes (organization_id, project_id, body) values (${ORG_B}, ${PRJ_B1}, 'x')`.execute(
          tx,
        ),
      ),
    );
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe('DB_RLS_VIOLATION');
  });

  it('refuses to insert a row for another project in a project transaction', async () => {
    const error = await rejected(
      withTenant(app, A1, (tx) =>
        sql`insert into app.fixture_notes (organization_id, project_id, body) values (${ORG_A}, ${PRJ_A2}, 'x')`.execute(
          tx,
        ),
      ),
    );
    expect((error as DbError).code).toBe('DB_RLS_VIOLATION');
  });

  // The composite foreign key: a row cannot hang off another organization's project.
  it('refuses a row in its own organization that points at another organization project', async () => {
    const error = await rejected(
      withTenant(app, A, (tx) =>
        sql`insert into app.fixture_notes (organization_id, project_id, body) values (${ORG_A}, ${PRJ_B1}, 'x')`.execute(
          tx,
        ),
      ),
    );
    expect(failure(error).code).toBe('23503');
    expect(await withTenant(app, B1, (tx) => rows(tx, bodies))).toEqual([{ body: 'b1 note' }]);
  });

  it('refuses an update that moves a row to another organization', async () => {
    const error = await rejected(
      withTenant(app, A1, (tx) =>
        sql`update app.fixture_notes set organization_id = ${ORG_B}, project_id = ${PRJ_B1} where id = ${NOTE_A1}`.execute(
          tx,
        ),
      ),
    );
    expect((error as DbError).code).toBe('DB_RLS_VIOLATION');
    expect(await withTenant(app, A1, (tx) => rows(tx, bodies))).toEqual([{ body: 'a1 note' }]);
  });

  it('refuses an update that moves a row to another project in a project transaction', async () => {
    const error = await rejected(
      withTenant(app, A1, (tx) =>
        sql`update app.fixture_notes set project_id = ${PRJ_A2} where id = ${NOTE_A1}`.execute(tx),
      ),
    );
    expect((error as DbError).code).toBe('DB_RLS_VIOLATION');
    expect(await withTenant(app, A2, (tx) => rows(tx, bodies))).toEqual([{ body: 'a2 note' }]);
  });

  it('refuses an organization row moved to another organization', async () => {
    const error = await rejected(
      withTenant(app, A, (tx) =>
        sql`update app.fixture_members set organization_id = ${ORG_B} where email = 'a@example.test'`.execute(
          tx,
        ),
      ),
    );
    expect((error as DbError).code).toBe('DB_RLS_VIOLATION');
  });

  it('allows the same unique key in two organizations and refuses a repeat in one', async () => {
    const error = await rejected(
      withTenant(app, A1, (tx) =>
        sql`insert into app.fixture_notes (organization_id, project_id, body, slug) values (${ORG_A}, ${PRJ_A1}, 'again', 'k1')`.execute(
          tx,
        ),
      ),
    );
    expect((error as DbError).code).toBe('DB_UNIQUE_VIOLATION');
    // B already holds k1 too, and its insert went through in the seed.
    expect(
      await withTenant(app, B1, (tx) =>
        rows(tx, sql<{ slug: string }>`select slug from app.fixture_notes`),
      ),
    ).toEqual([{ slug: 'k1' }]);
  });

  it('commits work that succeeds', async () => {
    await withTenant(app, A1, (tx) =>
      sql`insert into app.fixture_drafts (organization_id, project_id, body) values (${ORG_A}, ${PRJ_A1}, 'kept')`.execute(
        tx,
      ),
    );
    expect(
      await withTenant(app, A1, (tx) =>
        rows(tx, sql<{ body: string }>`select body from app.fixture_drafts`),
      ),
    ).toEqual([{ body: 'kept' }]);
  });

  it('rolls back work that throws and rethrows the same error', async () => {
    const thrown = new Error('the work failed');
    const error = await rejected(
      withTenant(app, A2, async (tx) => {
        await sql`insert into app.fixture_drafts (organization_id, project_id, body) values (${ORG_A}, ${PRJ_A2}, 'gone')`.execute(
          tx,
        );
        throw thrown;
      }),
    );
    expect(error).toBe(thrown);
    expect(
      await withTenant(app, A2, (tx) =>
        rows(tx, sql<{ body: string }>`select body from app.fixture_drafts`),
      ),
    ).toEqual([]);
  });

  // Postgres turns COMMIT of a failed transaction into ROLLBACK without an error, so work that
  // swallows a SQL error would otherwise report success for writes that never landed.
  it('fails when the work swallows a SQL error and returns', async () => {
    const error = await rejected(
      withTenant(app, A2, async (tx) => {
        await sql`insert into app.fixture_drafts (organization_id, project_id, body) values (${ORG_A}, ${PRJ_A2}, 'lost')`.execute(
          tx,
        );
        await sql`select 1 / 0`.execute(tx).catch(() => undefined);
        return 'looks fine';
      }),
    );
    expect(error).toBeInstanceOf(Error);
    expect(
      await withTenant(app, A2, (tx) =>
        rows(tx, sql<{ body: string }>`select body from app.fixture_drafts`),
      ),
    ).toEqual([]);
  });

  it.each<[string, unknown]>([
    ['an empty organization', { organizationId: '' }],
    ['a missing organization', {}],
    ['a malformed organization', { organizationId: 'org_x' }],
    ['an empty project', { organizationId: ORG_A, projectId: '' }],
    ['null', null],
  ])('refuses %s with DB_TENANT_CONTEXT_MISSING and never runs the work', async (_label, ctx) => {
    let ran = false;
    const error = await rejected(
      withTenant(app, ctx as OrganizationRef, () => {
        ran = true;
        return Promise.resolve(1);
      }),
    );
    expect((error as DbError).code).toBe('DB_TENANT_CONTEXT_MISSING');
    expect(ran).toBe(false);
  });
});
