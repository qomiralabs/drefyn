import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALLOW_LISTS } from '../../src/allow-lists.ts';
import { tenantTableSql } from '../../src/tenant-sql.ts';
import { describeFailure, fixtureMigrations, migrate, migration } from './support/cli.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { superuser } from './support/stack.ts';
import { catalogProblems, failure, rawSession } from './support/tenancy.ts';

const dbs = databases();

const USER_A = '01a14984-4476-77ce-9335-1280000000a1';
const USER_B = '01a14984-4476-77ce-9335-1280000000b1';
const ORG_A = '01a14984-4476-77ce-9335-1280000001a1';
const ORG_B = '01a14984-4476-77ce-9335-1280000001b1';
const PROJECT_A = '01a14984-4476-77ce-9335-1280000002a1';
const PROJECT_B = '01a14984-4476-77ce-9335-1280000002b1';
const ORG_EMPTY = '01a14984-4476-77ce-9335-1280000001f1';
// Never committed: every case that makes it rolls back.
const ORG_FRESH = '01a14984-4476-77ce-9335-128000000201';
const ORG_LATER = '01a14984-4476-77ce-9335-128000000211';
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

async function rejectedText(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return String(error);
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
      `insert into app.organizations (organization_id, name, plan_tier) values ('${org}', 'Org', 'self_hosted')`,
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
        `insert into app.organizations (organization_id, name, plan_tier) values ('${ORG_A}', 'x', 'self_hosted')`,
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
      "update app.organizations set name = 'Taken over'",
      "update app.organization_slugs set slug = 'taken-over'",
      "update app.memberships set default_project_role = 'editor'",
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
          `insert into app.organizations (organization_id, name, plan_tier) values ('${third}', 'x', 'self_hosted')`,
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
            `insert into app.organizations (organization_id, name, plan_tier) values ('${fourth}', 'x', 'self_hosted')`,
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

    // The insert policy refuses these before any constraint runs, so the constraints are
    // proved without RLS, as the superuser.
    it('holds one membership per person and organization', async () => {
      const error = await rejectedText(
        superuser(
          `insert into app.memberships (organization_id, user_id, role) values ('${ORG_A}', '${USER_A}', 'member');`,
          db.name,
        ),
      );
      expect(error).toContain('memberships_organization_user_key');
    });

    it.each([
      ['role', `'${USER_B}', 'superuser', null`, 'memberships_role_check'],
      [
        'default_project_role',
        `'${USER_B}', 'member', 'admin'`,
        'memberships_default_project_role_check',
      ],
    ])('refuses an unknown %s', async (_column, values, constraint) => {
      const error = await rejectedText(
        superuser(
          `insert into app.memberships (organization_id, user_id, role, default_project_role) values ('${ORG_A}', ${values});`,
          db.name,
        ),
      );
      expect(error).toContain(constraint);
    });

    it('refuses an unknown default project role for drefyn_app too', async () => {
      const app = await as('app');
      const code = await within(app, { org: ORG_FRESH }, async () => {
        await app.query(
          `insert into app.organizations (organization_id, name, plan_tier) values ('${ORG_FRESH}', 'x', 'self_hosted')`,
        );
        return sqlState(
          app.query(
            `insert into app.memberships (organization_id, user_id, role, default_project_role) values ('${ORG_FRESH}', '${USER_B}', 'owner', 'admin')`,
          ),
        );
      });
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
      // No organization row means no owner arm, so the policy refuses before the key does.
      expect(code).toBe('42501');
      const error = await rejectedText(
        superuser(
          `insert into app.memberships (organization_id, user_id, role) values ('${ghost}', '${USER_A}', 'owner');`,
          db.name,
        ),
      );
      expect(error).toContain('memberships_organization_id_fkey');
    });
  });

  describe('who may insert a membership, a tier or a read only state', () => {
    beforeAll(async () => {
      const app = await as('app');
      await committed(app, ORG_EMPTY, [
        `insert into app.organizations (organization_id, name, plan_tier) values ('${ORG_EMPTY}', 'Empty', 'self_hosted')`,
      ]);
    });

    it.each(['owner', 'admin', 'member'])(
      'refuses a %s into an organization that already has a member',
      async (role) => {
        const app = await as('app');
        const code = await within(app, { org: ORG_A }, () =>
          sqlState(
            app.query(
              'insert into app.memberships (organization_id, user_id, role) values ($1, $2, $3)',
              [ORG_A, USER_B, role],
            ),
          ),
        );
        expect(code).toBe('42501');
      },
    );

    it.each(['owner', 'admin', 'member'])(
      'refuses a %s into an organization made in an earlier transaction with no member',
      async (role) => {
        const app = await as('app');
        const code = await within(app, { org: ORG_EMPTY }, () =>
          sqlState(
            app.query(
              'insert into app.memberships (organization_id, user_id, role) values ($1, $2, $3)',
              [ORG_EMPTY, USER_B, role],
            ),
          ),
        );
        expect(code).toBe('42501');
      },
    );

    it.each(['admin', 'member'])(
      'refuses a %s as the first member of an organization made in this transaction',
      async (role) => {
        const app = await as('app');
        const code = await within(app, { org: ORG_FRESH }, async () => {
          await app.query(
            `insert into app.organizations (organization_id, name, plan_tier) values ('${ORG_FRESH}', 'x', 'self_hosted')`,
          );
          return sqlState(
            app.query(
              'insert into app.memberships (organization_id, user_id, role) values ($1, $2, $3)',
              [ORG_FRESH, USER_B, role],
            ),
          );
        });
        expect(code).toBe('42501');
      },
    );

    it('refuses a second owner in the transaction that made the organization', async () => {
      const app = await as('app');
      const code = await within(app, { org: ORG_FRESH }, async () => {
        await app.query(
          `insert into app.organizations (organization_id, name, plan_tier) values ('${ORG_FRESH}', 'x', 'self_hosted')`,
        );
        await app.query(
          `insert into app.memberships (organization_id, user_id, role) values ('${ORG_FRESH}', '${USER_A}', 'owner')`,
        );
        return sqlState(
          app.query(
            `insert into app.memberships (organization_id, user_id, role) values ('${ORG_FRESH}', '${USER_B}', 'owner')`,
          ),
        );
      });
      expect(code).toBe('42501');
    });

    it.each(['free', 'starter', 'growth', 'scale', 'enterprise'])(
      'refuses an organization at %s, which is not the install tier',
      async (tier) => {
        const app = await as('app');
        const code = await within(app, { org: ORG_FRESH }, () =>
          sqlState(
            app.query(
              'insert into app.organizations (organization_id, name, plan_tier) values ($1, $2, $3)',
              [ORG_FRESH, 'x', tier],
            ),
          ),
        );
        expect(code).toBe('42501');
      },
    );

    it('refuses an organization that starts read only', async () => {
      const app = await as('app');
      const code = await within(app, { org: ORG_FRESH }, () =>
        sqlState(
          app.query(
            `insert into app.organizations (organization_id, name, plan_tier, read_only_since)
             values ('${ORG_FRESH}', 'x', app.install_tier(), now())`,
          ),
        ),
      );
      expect(code).toBe('42501');
    });

    it('takes self_hosted as the install tier, which drefyn_app reads but cannot replace', async () => {
      const app = await as('app');
      const tier = await within(app, { org: ORG_FRESH }, async () => {
        const inserted = await app.query(
          `insert into app.organizations (organization_id, name, plan_tier) values ('${ORG_FRESH}', 'x', 'self_hosted')`,
        );
        expect(inserted.rowCount).toBe(1);
        return (await app.query<{ tier: string }>('select app.install_tier() as tier')).rows;
      });
      expect(tier).toEqual([{ tier: 'self_hosted' }]);
      const code = await within(app, { org: ORG_FRESH }, () =>
        sqlState(
          app.query(
            "create or replace function app.install_tier() returns text language sql stable parallel safe as $$ select 'enterprise'::text $$",
          ),
        ),
      );
      expect(code).toBe('42501');
    });

    // Both policies read memberships and organizations, whose own select policies read
    // memberships again; a cycle would fail here with infinite recursion.
    it('makes an owner with returning, and the owner then reads it under a user context', async () => {
      const app = await as('app');
      await app.query('begin');
      await app.query("select set_config('drefyn.organization_id', $1, true)", [ORG_LATER]);
      await app.query(
        `insert into app.organizations (organization_id, name, plan_tier) values ('${ORG_LATER}', 'Fresh', 'self_hosted')`,
      );
      await app.query(`insert into app.organization_slugs values ('fresh', '${ORG_LATER}')`);
      const made = await app.query<{ role: string }>(
        `insert into app.memberships (organization_id, user_id, role) values ('${ORG_LATER}', '${USER_B}', 'owner') returning role`,
      );
      await app.query('commit');
      expect(made.rows).toEqual([{ role: 'owner' }]);
      const seen = await within(app, { user: USER_B }, async () => ({
        orgs: (
          await app.query<{ slug: string; role: string }>(
            `select sl.slug, m.role from app.memberships m
               join app.organizations o using (organization_id)
               join app.organization_slugs sl using (organization_id)
              order by sl.slug`,
          )
        ).rows,
      }));
      expect(seen.orgs).toEqual([
        { slug: 'fresh', role: 'owner' },
        { slug: 'globex', role: 'owner' },
      ]);
    });

    // The tables here hold a few rows, so the planner is told to avoid a sequential scan;
    // what this asks is whether an index serves each probe at all.
    it('plans an index scan for each subquery of the membership policy', async () => {
      const app = await as('app');
      const plan = await within(app, { org: ORG_A }, async () => {
        await app.query('set local enable_seqscan = off');
        const result = await app.query<{ 'QUERY PLAN': string }>(
          `explain (costs off) insert into app.memberships (organization_id, user_id, role)
             values ('${ORG_A}', '${USER_B}', 'owner') returning id`,
        );
        return result.rows.map((r) => r['QUERY PLAN']).join('\n');
      });
      expect(plan).not.toContain('Seq Scan');
      expect(plan).toMatch(/Index Scan (using|on) memberships_\w+/);
      expect(plan).toContain('Index Scan using organizations_pkey on organizations o');
    });
  });

  describe('memberships born from an invitation', () => {
    const USER_C = '01a14984-4476-77ce-9335-1280000000c1';
    const INV_ADMIN = '01a14984-4476-77ce-9335-1280000003a1';
    const INV_MEMBER = '01a14984-4476-77ce-9335-1280000003b1';
    const INV_EXPIRED = '01a14984-4476-77ce-9335-1280000003c1';
    const INV_OTHER_ORG = '01a14984-4476-77ce-9335-1280000003d1';
    const INV_BY_ADMIN = '01a14984-4476-77ce-9335-1280000003e1';
    const USER_D = '01a14984-4476-77ce-9335-1280000000d1';
    const USER_E = '01a14984-4476-77ce-9335-1280000000e1';
    const ADMIN_D = '01a14984-4476-77ce-9335-1280000004d1';
    const MEMBER_E = '01a14984-4476-77ce-9335-1280000004e1';
    const inviteAs = (app: pg.Client, inviter: string, email: string, role: string) =>
      app.query(
        `insert into app.invitations (organization_id, email_normalized, role, secret_hash, invited_by, expires_at)
         values ($1, $2, $3, decode(repeat('00', 32), 'hex'), $4, now() + interval '1 day')`,
        [ORG_A, email, role, inviter],
      );
    const insert = (
      app: pg.Client,
      org: string,
      user: string,
      role: string,
      invitation: string | null,
    ) =>
      app.query(
        'insert into app.memberships (organization_id, user_id, role, invitation_id) values ($1, $2, $3, $4) returning id',
        [org, user, role, invitation],
      );

    beforeAll(async () => {
      const auth = await as('auth');
      await auth.query(
        `insert into app.users (id, email, email_normalized, email_verified_at)
         values ($1, 'c@example.com', 'c@example.com', now())`,
        [USER_C],
      );
      for (const [id, email] of [
        [USER_D, 'd@example.com'],
        [USER_E, 'e@example.com'],
      ] as const) {
        await auth.query(
          `insert into app.users (id, email, email_normalized, email_verified_at)
           values ($1, $2, $2, now())`,
          [id, email],
        );
      }
      // An admin and a member who joined earlier; their acceptance is not what is tested here.
      await superuser(
        `insert into app.memberships (id, organization_id, user_id, role) values
           ('${ADMIN_D}', '${ORG_A}', '${USER_D}', 'admin'),
           ('${MEMBER_E}', '${ORG_A}', '${USER_E}', 'member');`,
        db.name,
      );
      const app = await as('app');
      const invite = (org: string, id: string, email: string, role: string, expires: string) =>
        `insert into app.invitations (id, organization_id, email_normalized, role, secret_hash, invited_by, expires_at)
         values ('${id}', '${org}', '${email}', '${role}', decode(repeat('00', 32), 'hex'),
           (select id from app.memberships where organization_id = '${org}' and role = 'owner'), ${expires})`;
      await committed(app, ORG_A, [
        invite(ORG_A, INV_ADMIN, 'b@example.com', 'admin', "now() + interval '7 days'"),
        invite(ORG_A, INV_MEMBER, 'c@example.com', 'member', "now() + interval '7 days'"),
        invite(ORG_A, INV_EXPIRED, 'x@example.com', 'member', "now() - interval '1 second'"),
      ]);
      await committed(app, ORG_A, [
        `insert into app.invitations (id, organization_id, email_normalized, role, secret_hash, invited_by, expires_at)
         values ('${INV_BY_ADMIN}', '${ORG_A}', 'w@example.com', 'member', decode(repeat('00', 32), 'hex'),
           '${ADMIN_D}', now() + interval '7 days')`,
      ]);
      await committed(app, ORG_B, [
        invite(ORG_B, INV_OTHER_ORG, 'c@example.com', 'member', "now() + interval '7 days'"),
      ]);
    });

    it('refuses a member with no invitation', async () => {
      const app = await as('app');
      const code = await within(app, { org: ORG_A }, () =>
        sqlState(insert(app, ORG_A, USER_C, 'member', null)),
      );
      expect(code).toBe('42501');
    });

    it('refuses a member on an expired invitation', async () => {
      const app = await as('app');
      const code = await within(app, { org: ORG_A }, () =>
        sqlState(insert(app, ORG_A, USER_C, 'member', INV_EXPIRED)),
      );
      expect(code).toBe('42501');
    });

    it.each([
      ['owner', INV_MEMBER],
      ['admin', INV_MEMBER],
      ['member', INV_ADMIN],
      ['owner', INV_ADMIN],
    ])('refuses a %s on an invitation for another role', async (role, invitation) => {
      const app = await as('app');
      const code = await within(app, { org: ORG_A }, () =>
        sqlState(insert(app, ORG_A, USER_C, role, invitation)),
      );
      expect(code).toBe('42501');
    });

    it('refuses an invitation of another organization', async () => {
      const app = await as('app');
      const code = await within(app, { org: ORG_A }, () =>
        sqlState(insert(app, ORG_A, USER_C, 'member', INV_OTHER_ORG)),
      );
      expect(code).toBe('42501');
    });

    it('lets an admin invitation make an admin, then sets it free when the invitation goes', async () => {
      const app = await as('app');
      const after = await within(app, { org: ORG_A }, async () => {
        const made = await insert(app, ORG_A, USER_B, 'admin', INV_ADMIN);
        expect(made.rowCount).toBe(1);
        await app.query('delete from app.invitations where id = $1', [INV_ADMIN]);
        return (
          await app.query<{ role: string; invitation_id: string | null }>(
            'select role, invitation_id from app.memberships where user_id = $1 and organization_id = $2',
            [USER_B, ORG_A],
          )
        ).rows;
      });
      expect(after).toEqual([{ role: 'admin', invitation_id: null }]);
    });

    it('never makes two memberships from one invitation', async () => {
      const app = await as('app');
      const code = await within(app, { org: ORG_A }, async () => {
        await insert(app, ORG_A, USER_B, 'admin', INV_ADMIN);
        return sqlState(insert(app, ORG_A, USER_C, 'admin', INV_ADMIN));
      });
      expect(code).toBe('23505');
    });

    it("takes an inviter's pending invitations with them when they leave", async () => {
      const app = await as('app');
      const left = await within(app, { org: ORG_A }, async () => {
        const made = await insert(app, ORG_A, USER_B, 'admin', INV_ADMIN);
        const admin = made.rows[0] as { id: string };
        await app.query(
          `insert into app.invitations (organization_id, email_normalized, role, secret_hash, invited_by, expires_at)
           values ($1, 'y@example.com', 'member', decode(repeat('00', 32), 'hex'), $2, now() + interval '1 day')`,
          [ORG_A, admin.id],
        );
        const count = async () =>
          (
            await app.query<{ n: number }>(
              "select count(*)::int as n from app.invitations where email_normalized = 'y@example.com'",
            )
          ).rows[0]?.n;
        const before = await count();
        await app.query('delete from app.memberships where id = $1', [admin.id]);
        return { before, after: await count() };
      });
      expect(left).toEqual({ before: 1, after: 0 });
    });

    it('refuses an admin inviting anyone, themselves included, as owner', async () => {
      const app = await as('app');
      for (const email of ['d@example.com', 'new@example.com']) {
        const code = await within(app, { org: ORG_A }, () =>
          sqlState(inviteAs(app, ADMIN_D, email, 'owner')),
        );
        expect(code, email).toBe('42501');
      }
    });

    it.each(['admin', 'member', 'owner'])('refuses a member inviting a %s', async (role) => {
      const app = await as('app');
      const code = await within(app, { org: ORG_A }, () =>
        sqlState(inviteAs(app, MEMBER_E, 'new@example.com', role)),
      );
      expect(code).toBe('42501');
    });

    it('refuses an invitation that names a membership of no one in this organization', async () => {
      const app = await as('app');
      const code = await within(app, { org: ORG_A }, () =>
        sqlState(inviteAs(app, INV_OTHER_ORG, 'new@example.com', 'member')),
      );
      expect(code).toBe('42501');
    });

    it('refuses raising an invitation to owner by update, a resend included', async () => {
      const app = await as('app');
      const byUpdate = await within(app, { org: ORG_A }, () =>
        sqlState(
          app.query("update app.invitations set role = 'owner' where id = $1", [INV_BY_ADMIN]),
        ),
      );
      expect(byUpdate).toBe('42501');
      const byResend = await within(app, { org: ORG_A }, () =>
        sqlState(
          app.query(
            `insert into app.invitations (organization_id, email_normalized, role, secret_hash, invited_by, expires_at)
             values ($1, 'w@example.com', 'owner', decode(repeat('11', 32), 'hex'), $2, now() + interval '7 days')
             on conflict (organization_id, email_normalized) do update set role = excluded.role`,
            [ORG_A, ADMIN_D],
          ),
        ),
      );
      expect(byResend).toBe('42501');
    });

    it('lets an owner invite an owner and an admin invite an admin', async () => {
      const app = await as('app');
      const owner = await within(app, { org: ORG_A }, async () => {
        const id = (
          await app.query<{ id: string }>(
            "select id from app.memberships where organization_id = $1 and role = 'owner'",
            [ORG_A],
          )
        ).rows[0]?.id;
        return sqlState(inviteAs(app, id ?? '', 'o@example.com', 'owner'));
      });
      expect(owner).toBe('no error');
      const admin = await within(app, { org: ORG_A }, () =>
        sqlState(inviteAs(app, ADMIN_D, 'a2@example.com', 'admin')),
      );
      expect(admin).toBe('no error');
    });

    it('lets organization work add a block but never lift one', async () => {
      const app = await as('app');
      const codes = await within(app, { org: ORG_A }, async () => {
        const insertBlock = () =>
          app.query(
            `insert into app.invitation_blocks (organization_id, email_hmac)
             values ($1, decode(repeat('11', 32), 'hex'))
             on conflict (organization_id, email_hmac) do nothing returning id`,
            [ORG_A],
          );
        const first = await insertBlock();
        const second = await insertBlock();
        // A refused statement aborts the transaction, so each refusal gets its own savepoint.
        const refused = async (text: string) => {
          await app.query('savepoint refusal');
          const code = await sqlState(app.query(text));
          await app.query('rollback to savepoint refusal');
          return code;
        };
        return {
          first: first.rowCount,
          second: second.rowCount,
          remove: await refused('delete from app.invitation_blocks'),
          change: await refused('update app.invitation_blocks set email_hmac = email_hmac'),
          kept: (await app.query('select count(*)::int as n from app.invitation_blocks')).rows,
        };
      });
      expect(codes).toEqual({
        first: 1,
        second: 0,
        remove: '42501',
        change: '42501',
        kept: [{ n: 1 }],
      });
    });

    it('reaches no invitation or block of another organization', async () => {
      const app = await as('app');
      const seen = await within(app, { org: ORG_B }, async () => ({
        invitations: (await app.query('select id from app.invitations')).rows,
      }));
      expect(seen.invitations).toEqual([{ id: INV_OTHER_ORG }]);
    });
  });

  it('gives drefyn_auth no grant on any of them', async () => {
    const auth = await as('auth');
    for (const table of [...TABLES, 'invitations', 'invitation_blocks']) {
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
