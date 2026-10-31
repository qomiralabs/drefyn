import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALLOW_LISTS } from '../../src/allow-lists.ts';
import { tenantTableSql } from '../../src/tenant-sql.ts';
import { describeFailure, fixtureMigrations, migrate, migration } from './support/cli.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { catalogProblems, failure, rawSession } from './support/tenancy.ts';

const dbs = databases();

const USER_A = '01a14984-4476-77ce-9335-1280000000a1';
const USER_B = '01a14984-4476-77ce-9335-1280000000b1';
const ORG_A = '01a14984-4476-77ce-9335-1280000001a1';
const ORG_B = '01a14984-4476-77ce-9335-1280000001b1';
const PROJECT_A = '01a14984-4476-77ce-9335-1280000002a1';
const PROJECT_B = '01a14984-4476-77ce-9335-1280000002b1';
const TABLES = ['organizations', 'organization_slugs', 'memberships', 'projects'];

let db: TestDatabase;
const sessions: pg.Client[] = [];

async function as(role: 'app' | 'auth'): Promise<pg.Client> {
  const client = await rawSession(role, db.name);
  // The harness drops each database after its file and ends what is still connected.
  client.on('error', () => undefined);
  sessions.push(client);
  return client;
}

// Every block opens its own sessions, so they are closed once, after the whole file.
afterAll(async () => {
  for (const client of sessions.splice(0)) await client.end().catch(() => undefined);
});

type Scope = { readonly user: string } | { readonly org: string; readonly project?: string };

// The statements run in one transaction under the given setting and roll back, so each
// case starts from the seeded rows.
async function within<T>(client: pg.Client, scope: Scope, work: () => Promise<T>): Promise<T> {
  await client.query('begin');
  try {
    if ('user' in scope) {
      await client.query("select set_config('drefyn.user_id', $1, true)", [scope.user]);
    } else {
      await client.query("select set_config('drefyn.organization_id', $1, true)", [scope.org]);
      await client.query("select set_config('drefyn.project_id', $1, true)", [scope.project ?? '']);
    }
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

async function committed(client: pg.Client, org: string, statements: readonly string[]) {
  await client.query('begin');
  await client.query("select set_config('drefyn.organization_id', $1, true)", [org]);
  for (const text of statements) await client.query(text);
  await client.query('commit');
}

// Two people, each the owner of one organization with one docs project.
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
  for (const [org, user, slug, project] of [
    [ORG_A, USER_A, 'acme', PROJECT_A],
    [ORG_B, USER_B, 'globex', PROJECT_B],
  ] as const) {
    await committed(app, org, [
      `insert into app.organizations (organization_id, name, plan_tier) values ('${org}', 'Org', 'free')`,
      `insert into app.organization_slugs (slug, organization_id) values ('${slug}', '${org}')`,
      `insert into app.memberships (organization_id, user_id, role) values ('${org}', '${user}', 'owner')`,
      `insert into app.projects (id, organization_id, product, slug, name)
         values ('${project}', '${org}', 'docs', 'handbook', 'Handbook')`,
    ]);
  }
}

describeWithStack('organization tables', () => {
  beforeAll(async () => {
    db = await dbs.fresh('migrated');
    await seed();
  });

  describe('under a user context', () => {
    it('a member reads their organization, its slug and their own membership', async () => {
      const app = await as('app');
      const seen = await within(app, { user: USER_A }, async () => ({
        orgs: (await app.query('select organization_id from app.organizations')).rows,
        slugs: (await app.query('select slug from app.organization_slugs')).rows,
        members: (await app.query('select user_id from app.memberships')).rows,
      }));
      expect(seen).toEqual({
        orgs: [{ organization_id: ORG_A }],
        slugs: [{ slug: 'acme' }],
        members: [{ user_id: USER_A }],
      });
    });

    it('a non member slug resolves to nothing', async () => {
      const app = await as('app');
      const rows = await within(
        app,
        { user: USER_A },
        async () =>
          (
            await app.query<{ organization_id: string }>(
              "select organization_id from app.organization_slugs where slug = 'globex'",
            )
          ).rows,
      );
      expect(rows).toEqual([]);
    });

    it('reads no project, since projects are organization work', async () => {
      const app = await as('app');
      const rows = await within(
        app,
        { user: USER_A },
        async () => (await app.query<{ id: string }>('select id from app.projects')).rows,
      );
      expect(rows).toEqual([]);
    });

    it.each([
      [
        'organizations',
        `insert into app.organizations (organization_id, name, plan_tier) values ('${ORG_A}', 'x', 'free')`,
      ],
      ['organization_slugs', `insert into app.organization_slugs values ('new-one', '${ORG_A}')`],
      [
        'memberships',
        `insert into app.memberships (organization_id, user_id, role) values ('${ORG_B}', '${USER_A}', 'owner')`,
      ],
    ])('refuses an insert into %s', async (_table, text) => {
      const app = await as('app');
      expect(await within(app, { user: USER_A }, () => sqlState(app.query(text)))).toBe('42501');
    });

    it.each([
      "update app.organizations set plan_tier = 'enterprise'",
      "update app.organization_slugs set slug = 'taken-over'",
      "update app.memberships set role = 'owner'",
      'delete from app.memberships',
    ])('changes no row with %s', async (text) => {
      const app = await as('app');
      const result = await within(app, { user: USER_A }, () => app.query(text));
      expect(result.rowCount).toBe(0);
    });
  });

  describe('under an organization context', () => {
    it('reads only its own rows in all four tables', async () => {
      const app = await as('app');
      const counts = await within(app, { org: ORG_A }, async () => {
        const out: Record<string, unknown> = {};
        for (const table of TABLES) {
          out[table] = (await app.query(`select organization_id from app.${table}`)).rows.map(
            (r: { organization_id: string }) => r.organization_id,
          );
        }
        return out;
      });
      for (const table of TABLES) expect(counts[table], table).toEqual([ORG_A]);
    });

    it('a slug is one namespace across organizations', async () => {
      const app = await as('app');
      const third = '01a14984-4476-77ce-9335-1280000001c1';
      const code = await within(app, { org: third }, async () => {
        await app.query(
          `insert into app.organizations (organization_id, name, plan_tier) values ('${third}', 'x', 'free')`,
        );
        return sqlState(
          app.query(`insert into app.organization_slugs values ('globex', '${third}')`),
        );
      });
      expect(code).toBe('23505');
    });

    it('gives an organization one slug only', async () => {
      const app = await as('app');
      const code = await within(app, { org: ORG_A }, () =>
        sqlState(app.query(`insert into app.organization_slugs values ('acme-two', '${ORG_A}')`)),
      );
      expect(code).toBe('23505');
    });

    it.each(['', 'Acme', '-acme', 'acme-', 'ac_me', 'a'.repeat(41), 'acme.com', 'acme corp'])(
      'refuses the slug %j',
      async (slug) => {
        const app = await as('app');
        const fourth = '01a14984-4476-77ce-9335-1280000001d1';
        const code = await within(app, { org: fourth }, async () => {
          await app.query(
            `insert into app.organizations (organization_id, name, plan_tier) values ('${fourth}', 'x', 'free')`,
          );
          return sqlState(
            app.query('insert into app.organization_slugs values ($1, $2)', [slug, fourth]),
          );
        });
        expect(code).toBe('23514');
      },
    );

    // Organization scoped code runs as drefyn_app too, so RLS alone would let it raise its
    // own plan, lift its own read only state or promote itself.
    it.each([
      ['organizations', "plan_tier = 'enterprise'"],
      ['organizations', 'read_only_since = null'],
      ['organizations', 'organization_id = organization_id'],
      ['memberships', "role = 'owner'"],
      ['memberships', 'user_id = user_id'],
      ['projects', 'read_only_since = null'],
    ])('refuses an update of %s set %s with permission denied', async (table, assignment) => {
      const app = await as('app');
      const code = await within(app, { org: ORG_A }, () =>
        sqlState(app.query(`update app.${table} set ${assignment}`)),
      );
      expect(code).toBe('42501');
    });

    it.each([
      ['organizations', "name = 'Renamed', updated_at = now()"],
      ['memberships', "default_project_role = 'viewer', updated_at = now()"],
      ['projects', "name = 'Renamed', slug = 'renamed', updated_at = now()"],
      ['organization_slugs', "slug = 'acme-renamed'"],
    ])('still lets organization work update %s set %s', async (table, assignment) => {
      const app = await as('app');
      const result = await within(app, { org: ORG_A }, () =>
        app.query(`update app.${table} set ${assignment}`),
      );
      expect(result.rowCount).toBe(1);
    });

    it('holds one membership per person and organization', async () => {
      const app = await as('app');
      const code = await within(app, { org: ORG_A }, () =>
        sqlState(
          app.query(
            `insert into app.memberships (organization_id, user_id, role) values ('${ORG_A}', '${USER_A}', 'member')`,
          ),
        ),
      );
      expect(code).toBe('23505');
    });

    it.each([
      ['role', `'${USER_B}', 'superuser', null`],
      ['default_project_role', `'${USER_B}', 'member', 'admin'`],
    ])('refuses an unknown %s', async (_column, values) => {
      const app = await as('app');
      const code = await within(app, { org: ORG_A }, () =>
        sqlState(
          app.query(
            `insert into app.memberships (organization_id, user_id, role, default_project_role) values ('${ORG_A}', ${values})`,
          ),
        ),
      );
      expect(code).toBe('23514');
    });

    it('keeps project slugs unique per organization and product only', async () => {
      const app = await as('app');
      const insert = (product: string) =>
        app.query(
          `insert into app.projects (organization_id, product, slug, name) values ('${ORG_A}', '${product}', 'handbook', 'x')`,
        );
      expect(await within(app, { org: ORG_A }, () => sqlState(insert('docs')))).toBe('23505');
      expect(await within(app, { org: ORG_A }, () => sqlState(insert('studio')))).toBe('no error');
      expect(await within(app, { org: ORG_A }, () => sqlState(insert('blog')))).toBe('23514');
    });

    it('refuses a membership for an organization that does not exist', async () => {
      const app = await as('app');
      const ghost = '01a14984-4476-77ce-9335-1280000001e1';
      const code = await within(app, { org: ghost }, () =>
        sqlState(
          app.query(
            `insert into app.memberships (organization_id, user_id, role) values ('${ghost}', '${USER_A}', 'owner')`,
          ),
        ),
      );
      expect(code).toBe('23503');
    });
  });

  it('gives drefyn_auth no grant on any of them', async () => {
    const auth = await as('auth');
    for (const table of TABLES) {
      expect(await sqlState(auth.query(`select 1 from app.${table}`)), table).toBe('42501');
    }
  });
});

describeWithStack('a project table pointing at app.projects', () => {
  it('passes check:catalog with the composite key and cannot reach another organization', async () => {
    db = await dbs.fresh('base');
    const dir = fixtureMigrations({
      '9000000000001_pages.sql': migration(
        tenantTableSql({ name: 'fixture_pages', scope: 'project', columns: ['body text'] }),
        'drop table app.fixture_pages;',
      ),
    });
    const up = await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir });
    expect(up.code, describeFailure(up)).toBe(0);
    expect(await catalogProblems(db.owner, ALLOW_LISTS)).toEqual([]);
    await seed();
    const app = await as('app');
    const insert = (project: string) =>
      app.query(
        `insert into app.fixture_pages (organization_id, project_id, body) values ('${ORG_B}', '${project}', 'x')`,
      );
    expect(
      await within(app, { org: ORG_B, project: PROJECT_B }, () => sqlState(insert(PROJECT_B))),
    ).toBe('no error');
    expect(
      await within(app, { org: ORG_B, project: PROJECT_A }, () => sqlState(insert(PROJECT_A))),
    ).toBe('23503');
  });
});
