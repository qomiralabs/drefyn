import { organizationId, projectId } from '@drefyn/tenancy';
import { beforeAll, expect, it } from 'vitest';
import { rejected } from '../support.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { query } from './support/sql.ts';
import { superuser } from './support/stack.ts';
import { failure, fixtureTemplate, rawSession, seed, seedProject } from './support/tenancy.ts';

const dbs = databases();
const fixture = fixtureTemplate(dbs);

const ORG_A = organizationId('01a14984-4476-77ce-9335-20000000000a');
const PRJ_A1 = projectId('01a14984-4476-77ce-9335-2000000000a1');

let db: TestDatabase;

// Runs one statement as the role on its own connection and returns the SQLSTATE it failed
// with, or 'allowed'.
async function attempt(role: 'app' | 'reader', statement: string): Promise<string> {
  const client = await rawSession(role, db.name);
  try {
    await client.query(statement);
    return 'allowed';
  } catch (error) {
    return failure(error).code ?? 'no code';
  } finally {
    await client.end();
  }
}

async function rlsState(table: string) {
  const out = await superuser(
    `select relrowsecurity || '|' || relforcerowsecurity || '|' ||
            (select count(*) from pg_policy where polrelid = c.oid)
       from pg_class c where oid = 'app.${table}'::regclass;`,
    db.name,
  );
  return out.trim();
}

describeWithStack('drefyn_app cannot get around row level security', () => {
  beforeAll(async () => {
    db = await fixture();
    await seedProject(db.app, ORG_A, PRJ_A1);
    await seed(db.app, ORG_A, PRJ_A1, [
      {
        text: "insert into app.fixture_notes (organization_id, project_id, body) values ($1, $2, 'secret')",
        values: [ORG_A, PRJ_A1],
      },
    ]);
  });

  it('is not a superuser, has no BYPASSRLS, owns nothing in app and belongs to no role', async () => {
    const [role] = await query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolinherit: boolean;
      rolcreaterole: boolean;
    }>(
      db.owner,
      `select rolsuper, rolbypassrls, rolinherit, rolcreaterole from pg_roles where rolname = 'drefyn_app'`,
    );
    expect(role).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolinherit: false,
      rolcreaterole: false,
    });
    expect(
      await query(
        db.owner,
        `select relname from pg_class where relnamespace = 'app'::regnamespace and pg_get_userbyid(relowner) = 'drefyn_app'`,
      ),
    ).toEqual([]);
    expect(
      await query(
        db.owner,
        `select roleid::regrole::text from pg_auth_members where member = 'drefyn_app'::regrole`,
      ),
    ).toEqual([]);
  });

  it.each([
    ['disable row level security', 'alter table app.fixture_notes disable row level security'],
    ['drop the force', 'alter table app.fixture_notes no force row level security'],
    ['drop the policy', 'drop policy tenant_isolation on app.fixture_notes'],
    ['add an open policy', 'create policy open on app.fixture_notes using (true)'],
    ['alter the policy', 'alter policy tenant_isolation on app.fixture_notes using (true)'],
    ['take the table', 'alter table app.fixture_notes owner to drefyn_app'],
    ['grant itself BYPASSRLS', 'alter role drefyn_app bypassrls'],
    ['become the owner', 'set role drefyn_owner'],
    ['become the superuser', 'set role postgres'],
    ['switch session user', 'set session authorization postgres'],
    ['create a table', 'create table app.sneaky (id int)'],
    [
      'create a security definer function',
      'create function app.sneaky() returns int language sql security definer as $$ select 1 $$',
    ],
    ['create a view', 'create view app.sneaky as select * from app.fixture_notes'],
    ['create a temp table', 'create temp table sneaky (id int)'],
    ['create in public', 'create table public.sneaky (id int)'],
    // TRUNCATE skips row level security entirely.
    ['truncate', 'truncate app.fixture_notes'],
  ])('is refused when it tries to %s', async (_label, statement) => {
    expect(await attempt('app', statement)).toBe('42501');
  });

  // Without the grant option Postgres only warns, so the proof is the privileges after.
  it('cannot pass its privileges on or widen its own', async () => {
    await attempt('app', 'grant select on app.fixture_notes to drefyn_public_reader');
    await attempt('app', 'grant all on app.fixture_notes to drefyn_app');
    expect(
      await query(
        db.owner,
        `select has_table_privilege('drefyn_public_reader', 'app.fixture_notes', 'SELECT') as reader,
                has_table_privilege('drefyn_app', 'app.fixture_notes', 'TRUNCATE') as truncate,
                has_table_privilege('drefyn_app', 'app.fixture_notes', 'SELECT WITH GRANT OPTION') as regrant`,
      ),
    ).toEqual([{ reader: false, truncate: false, regrant: false }]);
  });

  it('gets an error, not every row, when it turns row_security off', async () => {
    const client = await rawSession('app', db.name);
    try {
      await client.query('set row_security = off');
      const error = await rejected(client.query('select * from app.fixture_notes'));
      expect(failure(error).code).toBe('42501');
    } finally {
      await client.end();
    }
  });

  it('leaves row level security, the force and the policy as they were', async () => {
    expect(await rlsState('fixture_notes')).toBe('true|true|1');
    expect((await superuser('select count(*) from app.fixture_notes;', db.name)).trim()).toBe('1');
  });
});

describeWithStack('only drefyn_owner runs DDL in app', () => {
  beforeAll(async () => {
    db = await fixture();
  });

  it.each([
    ['create a table', 'create table app.sneaky (id int)'],
    ['add a column', 'alter table app.fixture_notes add column x int'],
    ['drop a table', 'drop table app.fixture_drafts'],
    ['create an index', 'create index sneaky_idx on app.fixture_notes (body)'],
    [
      'create a function',
      'create function app.sneaky() returns int language sql as $$ select 1 $$',
    ],
    [
      'insert',
      "insert into app.fixture_published (organization_id, project_id, body) values ('01a14984-4476-77ce-9335-20000000000a', '01a14984-4476-77ce-9335-2000000000a1', 'x')",
    ],
  ])('refuses the reader when it tries to %s', async (_label, statement) => {
    expect(await attempt('reader', statement)).toBe('42501');
  });

  it('lets the owner change the schema', async () => {
    await query(db.owner, 'alter table app.fixture_notes add column extra text');
    await query(db.owner, 'alter table app.fixture_notes drop column extra');
  });
});
