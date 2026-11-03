import type pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ALLOW_LISTS } from '../../src/allow-lists.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { catalogProblems, failure, rawSession } from './support/tenancy.ts';

const dbs = databases();

const USER_A = '01a14984-4476-77ce-9335-1280000000a1';
const USER_B = '01a14984-4476-77ce-9335-1280000000b1';
const ORG_A = '01a14984-4476-77ce-9335-1280000001a1';
const ORG_B = '01a14984-4476-77ce-9335-1280000001b1';
const MEMBER_A = '01a14984-4476-77ce-9335-1280000003a1';
const MEMBER_B = '01a14984-4476-77ce-9335-1280000003b1';
const PROJECT_A = '01a14984-4476-77ce-9335-1280000002a1';
const PROJECT_B = '01a14984-4476-77ce-9335-1280000002b1';
const KEY_A = '01a14984-4476-77ce-9335-1280000004a1';
const KEY_B = '01a14984-4476-77ce-9335-1280000004b1';
const KEY_C = '01a14984-4476-77ce-9335-1280000004e1';
const TABLES = ['api_keys', 'api_key_projects'];

let db: TestDatabase;
const sessions: pg.Client[] = [];

async function as(role: 'app' | 'auth'): Promise<pg.Client> {
  const client = await rawSession(role, db.name);
  client.on('error', () => undefined);
  sessions.push(client);
  return client;
}

afterAll(async () => {
  for (const client of sessions.splice(0)) await client.end().catch(() => undefined);
});

// Runs under one organization and rolls back, so each case starts from the seeded rows.
async function within<T>(client: pg.Client, org: string, work: () => Promise<T>): Promise<T> {
  await client.query('begin');
  try {
    await client.query("select set_config('drefyn.organization_id', $1, true)", [org]);
    await client.query("select set_config('drefyn.project_id', '', true)");
    return await work();
  } finally {
    await client.query('rollback');
  }
}

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return failure(error).code;
  }
  return 'no error';
}

const keyInsert = (org: string, id: string, member: string, extra = '') =>
  `insert into app.api_keys (id, organization_id, name, secret_hash, display_suffix, scopes,
     project_scope, created_by, idempotency_key, request_hash ${extra === '' ? '' : ', expires_at'})
   values ('${id}', '${org}', 'CI', decode(repeat('ab', 32), 'hex'), 'a1b2', array['docs:read'],
     'listed', '${member}', 'k-${id}', decode(repeat('cd', 32), 'hex') ${extra === '' ? '' : `, ${extra}`})`;

// Two organizations, each with an owner, a docs project and one key listed on that project.
async function seed(): Promise<void> {
  const auth = await as('auth');
  for (const [id, email] of [
    [USER_A, 'a@example.com'],
    [USER_B, 'b@example.com'],
  ] as const) {
    await auth.query(
      `insert into app.users (id, email, email_normalized, email_verified_at)
       values ($1, $2, $2, now())`,
      [id, email],
    );
  }
  const app = await as('app');
  for (const [org, user, slug, project, member, key] of [
    [ORG_A, USER_A, 'acme', PROJECT_A, MEMBER_A, KEY_A],
    [ORG_B, USER_B, 'globex', PROJECT_B, MEMBER_B, KEY_B],
  ] as const) {
    await app.query('begin');
    await app.query("select set_config('drefyn.organization_id', $1, true)", [org]);
    for (const text of [
      `insert into app.organizations (organization_id, name, plan_tier) values ('${org}', 'Org', 'free')`,
      `insert into app.organization_slugs (slug, organization_id) values ('${slug}', '${org}')`,
      `insert into app.memberships (id, organization_id, user_id, role) values ('${member}', '${org}', '${user}', 'owner')`,
      `insert into app.projects (id, organization_id, product, slug, name)
         values ('${project}', '${org}', 'docs', 'handbook', 'Handbook')`,
      keyInsert(org, key, member),
      `insert into app.api_key_projects (organization_id, api_key_id, target_project_id)
         values ('${org}', '${key}', '${project}')`,
    ]) {
      await app.query(text);
    }
    await app.query('commit');
  }
}

describeWithStack('API key tables', () => {
  beforeAll(async () => {
    db = await dbs.fresh('migrated');
    await seed();
  });

  it('read only their own organization rows', async () => {
    const app = await as('app');
    const seen = await within(app, ORG_A, async () => {
      const out: Record<string, unknown> = {};
      for (const table of TABLES) {
        out[table] = (await app.query(`select organization_id from app.${table}`)).rows.map(
          (r: { organization_id: string }) => r.organization_id,
        );
      }
      return out;
    });
    for (const table of TABLES) expect(seen[table], table).toEqual([ORG_A]);
  });

  it('read nothing with no organization set', async () => {
    const app = await as('app');
    const rows = (await app.query('select id from app.api_keys')).rows;
    expect(rows).toEqual([]);
  });

  it('refuse a key or a project row for another organization', async () => {
    const app = await as('app');
    expect(
      await within(app, ORG_A, () =>
        sqlState(app.query(keyInsert(ORG_B, '01a14984-4476-77ce-9335-1280000004c1', MEMBER_B))),
      ),
    ).toBe('42501');
    // Under its own organization, a row naming another organization's project has no target.
    expect(
      await within(app, ORG_A, () =>
        sqlState(
          app.query(
            `insert into app.api_key_projects (organization_id, api_key_id, target_project_id)
               values ('${ORG_A}', '${KEY_A}', '${PROJECT_B}')`,
          ),
        ),
      ),
    ).toBe('23503');
  });

  it.each([
    ['api_keys', 'secret_hash = secret_hash'],
    ['api_keys', 'scopes = scopes'],
    ['api_keys', "project_scope = 'all'"],
    ['api_keys', 'expires_at = null'],
    ['api_keys', 'created_by = null'],
    ['api_keys', 'organization_id = organization_id'],
    ['api_key_projects', 'target_project_id = target_project_id'],
  ])('refuse an update of %s set %s with permission denied', async (table, assignment) => {
    const app = await as('app');
    expect(
      await within(app, ORG_A, () => sqlState(app.query(`update app.${table} set ${assignment}`))),
    ).toBe('42501');
  });

  it('still let organization work record when a key was used', async () => {
    const app = await as('app');
    const result = await within(app, ORG_A, () =>
      app.query('update app.api_keys set last_used_at = now()'),
    );
    expect(result.rowCount).toBe(1);
  });

  it.each([
    [
      'a project scope outside the list',
      keyInsert(ORG_A, KEY_C, MEMBER_A).replace("'listed'", "'some'"),
    ],
    [
      'a short hash',
      keyInsert(ORG_A, KEY_C, MEMBER_A).replace("repeat('ab', 32)", "repeat('ab', 31)"),
    ],
    [
      'a suffix outside the alphabet',
      keyInsert(ORG_A, KEY_C, MEMBER_A).replace("'a1b2'", "'a1bu'"),
    ],
    ['no scopes', keyInsert(ORG_A, KEY_C, MEMBER_A).replace("array['docs:read']", "'{}'::text[]")],
    ['an expiry before creation', keyInsert(ORG_A, KEY_C, MEMBER_A, "now() - interval '1 day'")],
  ])('refuse %s', async (_name, text) => {
    const app = await as('app');
    expect(await within(app, ORG_A, () => sqlState(app.query(text)))).toBe('23514');
  });

  it('hold one key per idempotency key in an organization', async () => {
    const app = await as('app');
    const again = keyInsert(ORG_A, '01a14984-4476-77ce-9335-1280000004d1', MEMBER_A).replace(
      "'k-01a14984-4476-77ce-9335-1280000004d1'",
      `'k-${KEY_A}'`,
    );
    expect(await within(app, ORG_A, () => sqlState(app.query(again)))).toBe('23505');
  });

  it('drop the listed row with its project and keep the key listed', async () => {
    const app = await as('app');
    const seen = await within(app, ORG_A, async () => {
      await app.query(`delete from app.projects where id = '${PROJECT_A}'`);
      const scope = await app.query<{ project_scope: string }>(
        `select project_scope from app.api_keys where id = '${KEY_A}'`,
      );
      const listed = await app.query('select 1 from app.api_key_projects');
      return { scope: scope.rows[0]?.project_scope, listed: listed.rowCount };
    });
    expect(seen).toEqual({ scope: 'listed', listed: 0 });
  });

  it("clear only the creator when the creator's membership goes", async () => {
    const app = await as('app');
    const seen = await within(app, ORG_A, async () => {
      await app.query(`delete from app.memberships where id = '${MEMBER_A}'`);
      const row = await app.query<{ organization_id: string; created_by: string | null }>(
        `select organization_id, created_by from app.api_keys where id = '${KEY_A}'`,
      );
      return row.rows[0];
    });
    expect(seen).toEqual({ organization_id: ORG_A, created_by: null });
  });

  it('give drefyn_auth no grant on either table', async () => {
    const auth = await as('auth');
    for (const table of TABLES) {
      expect(await sqlState(auth.query(`select 1 from app.${table}`)), table).toBe('42501');
    }
  });

  it('pass check:catalog', async () => {
    expect(await catalogProblems(db.owner, ALLOW_LISTS)).toEqual([]);
  });
});
