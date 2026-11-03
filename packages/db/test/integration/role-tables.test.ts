import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALLOW_LISTS, RESTRICTIVE_POLICIES } from '../../src/allow-lists.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { superuser } from './support/stack.ts';
import { catalogProblems, failure, rawSession } from './support/tenancy.ts';

const dbs = databases();

const id = (n: number) => `01a14984-4476-77ce-9335-13${String(n).padStart(10, '0')}`;

// Organization A: two owners, an admin and two members. Organization B: one owner.
const ORG_A = id(1);
const ORG_B = id(2);
const OWNER_1 = { user: id(11), member: id(21) };
const OWNER_2 = { user: id(12), member: id(22) };
const ADMIN = { user: id(13), member: id(23) };
const MEMBER = { user: id(14), member: id(24) };
const OTHER = { user: id(15), member: id(25) };
const LONE_OWNER = { user: id(16), member: id(26) };
const PROJECT_A = id(31);
const PROJECT_A2 = id(32);
const PROJECT_B = id(33);
const KEY_A = id(41);

let db: TestDatabase;
const sessions: pg.Client[] = [];

async function app(): Promise<pg.Client> {
  const client = await rawSession('app', db.name);
  client.on('error', () => undefined);
  sessions.push(client);
  return client;
}

afterAll(async () => {
  for (const client of sessions.splice(0)) await client.end().catch(() => undefined);
});

// One transaction under the organization and actor, rolled back, so each case starts from
// the seed.
async function within<T>(
  client: pg.Client,
  org: string,
  actor: string,
  work: () => Promise<T>,
): Promise<T> {
  await client.query('begin');
  try {
    await client.query("select set_config('drefyn.organization_id', $1, true)", [org]);
    await client.query("select set_config('drefyn.project_id', '', true)");
    await client.query("select set_config('drefyn.actor_user_id', $1, true)", [actor]);
    return await work();
  } finally {
    await client.query('rollback');
  }
}

async function sqlState(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return failure(error).code ?? 'no code';
  }
  return 'no error';
}

const setRole = (client: pg.Client, member: string, role: string) =>
  client.query('update app.memberships set role = $2, updated_at = now() where id = $1', [
    member,
    role,
  ]);

const remove = (client: pg.Client, member: string) =>
  client.query('delete from app.memberships where id = $1', [member]);

const roleOf = async (client: pg.Client, member: string) =>
  (await client.query<{ role: string }>('select role from app.memberships where id = $1', [member]))
    .rows[0]?.role;

// Seeded as the superuser: how members got here is not what these tests are about.
async function seed(): Promise<void> {
  const people = [OWNER_1, OWNER_2, ADMIN, MEMBER, OTHER, LONE_OWNER];
  const users = people
    .map((p, i) => `('${p.user}', 'r${String(i)}@example.com', 'r${String(i)}@example.com', now())`)
    .join(', ');
  await superuser(
    `insert into app.users (id, email, email_normalized, email_verified_at) values ${users};
     insert into app.organizations (organization_id, name, plan_tier) values
       ('${ORG_A}', 'A', 'self_hosted'), ('${ORG_B}', 'B', 'self_hosted');
     insert into app.memberships (id, organization_id, user_id, role, default_project_role) values
       ('${OWNER_1.member}', '${ORG_A}', '${OWNER_1.user}', 'owner', null),
       ('${OWNER_2.member}', '${ORG_A}', '${OWNER_2.user}', 'owner', null),
       ('${ADMIN.member}', '${ORG_A}', '${ADMIN.user}', 'admin', null),
       ('${MEMBER.member}', '${ORG_A}', '${MEMBER.user}', 'member', 'viewer'),
       ('${OTHER.member}', '${ORG_A}', '${OTHER.user}', 'member', null),
       ('${LONE_OWNER.member}', '${ORG_B}', '${LONE_OWNER.user}', 'owner', null);
     insert into app.projects (id, organization_id, product, slug, name) values
       ('${PROJECT_A}', '${ORG_A}', 'docs', 'handbook', 'Handbook'),
       ('${PROJECT_A2}', '${ORG_A}', 'docs', 'guide', 'Guide'),
       ('${PROJECT_B}', '${ORG_B}', 'docs', 'handbook', 'Handbook');
     insert into app.api_keys (id, organization_id, name, secret_hash, display_suffix, scopes,
         project_scope, created_by, idempotency_key, request_hash)
       values ('${KEY_A}', '${ORG_A}', 'CI', decode(repeat('ab', 32), 'hex'), 'a1b2',
         array['docs:read'], 'all', '${ADMIN.member}', 'k-a', decode(repeat('cd', 32), 'hex'));`,
    db.name,
  );
}

describeWithStack('role changes at the database', () => {
  beforeAll(async () => {
    db = await dbs.fresh('migrated');
    await seed();
  });

  describe('who may change a role', () => {
    it.each<[string, string, string, string]>([
      ['an owner promotes a member to owner', OWNER_1.user, MEMBER.member, 'owner'],
      ['an owner demotes the other owner', OWNER_1.user, OWNER_2.member, 'member'],
      [
        'an owner demotes themselves while another owner exists',
        OWNER_1.user,
        OWNER_1.member,
        'admin',
      ],
      ['an admin promotes a member to admin', ADMIN.user, MEMBER.member, 'admin'],
      ['an admin demotes themselves', ADMIN.user, ADMIN.member, 'member'],
    ])('lets %s', async (_label, actor, member, role) => {
      const client = await app();
      const seen = await within(client, ORG_A, actor, async () => {
        const result = await setRole(client, member, role);
        return { rows: result.rowCount, role: await roleOf(client, member) };
      });
      expect(seen).toEqual({ rows: 1, role });
    });

    // USING filters the old row without an error, so the code reads 0 rows as a refusal.
    it.each<[string, string, string, string]>([
      ['an admin demoting an owner', ADMIN.user, OWNER_1.member, 'member'],
      ['an admin promoting an owner to the same role', ADMIN.user, OWNER_1.member, 'owner'],
      ['a member promoting themselves', MEMBER.user, MEMBER.member, 'admin'],
      ['a member demoting an admin', MEMBER.user, ADMIN.member, 'member'],
      ['nobody acting', '', MEMBER.member, 'admin'],
      ['an owner of another organization', LONE_OWNER.user, MEMBER.member, 'admin'],
    ])('changes no row for %s', async (_label, actor, member, role) => {
      const client = await app();
      const seen = await within(client, ORG_A, actor, async () => {
        const before = await roleOf(client, member);
        const result = await setRole(client, member, role);
        return { rows: result.rowCount, same: (await roleOf(client, member)) === before };
      });
      expect(seen).toEqual({ rows: 0, same: true });
    });

    // WITH CHECK raises on the new row: an admin never writes owner, themselves included.
    it.each<[string, string, string]>([
      ['a member', ADMIN.user, MEMBER.member],
      ['themselves', ADMIN.user, ADMIN.member],
    ])('refuses an admin making %s owner with 42501', async (_label, actor, member) => {
      const client = await app();
      const code = await within(client, ORG_A, actor, () =>
        sqlState(setRole(client, member, 'owner')),
      );
      expect(code).toBe('42501');
    });

    it('refuses demoting the last owner with 42501', async () => {
      const client = await app();
      const code = await within(client, ORG_B, LONE_OWNER.user, () =>
        sqlState(setRole(client, LONE_OWNER.member, 'admin')),
      );
      expect(code).toBe('42501');
    });

    it('lets the owner set a default project role, and nobody without an actor', async () => {
      const client = await app();
      const rows = await within(
        client,
        ORG_A,
        OWNER_1.user,
        async () =>
          (
            await client.query(
              "update app.memberships set default_project_role = 'editor' where id = $1",
              [OTHER.member],
            )
          ).rowCount,
      );
      expect(rows).toBe(1);
      const none = await within(
        client,
        ORG_A,
        '',
        async () =>
          (
            await client.query(
              "update app.memberships set default_project_role = 'editor' where id = $1",
              [OTHER.member],
            )
          ).rowCount,
      );
      expect(none).toBe(0);
    });

    // Only role, default_project_role and updated_at are granted.
    it.each(['user_id = user_id', 'organization_id = organization_id', 'invitation_id = null'])(
      'refuses an update of memberships set %s with permission denied',
      async (assignment) => {
        const client = await app();
        const code = await within(client, ORG_A, OWNER_1.user, () =>
          sqlState(client.query(`update app.memberships set ${assignment}`)),
        );
        expect(code).toBe('42501');
      },
    );
  });

  describe('who may remove a member', () => {
    it.each<[string, string, string]>([
      ['an owner removes the other owner', OWNER_1.user, OWNER_2.member],
      ['an owner removes an admin', OWNER_1.user, ADMIN.member],
      ['an admin removes a member', ADMIN.user, MEMBER.member],
    ])('lets %s', async (_label, actor, member) => {
      const client = await app();
      const rows = await within(
        client,
        ORG_A,
        actor,
        async () => (await remove(client, member)).rowCount,
      );
      expect(rows).toBe(1);
    });

    it.each<[string, string, string, string]>([
      ['an admin removing an owner', ORG_A, ADMIN.user, OWNER_1.member],
      ['a member removing a member', ORG_A, MEMBER.user, OTHER.member],
      ['nobody acting', ORG_A, '', MEMBER.member],
      ['the last owner removing themselves', ORG_B, LONE_OWNER.user, LONE_OWNER.member],
    ])('deletes no row for %s', async (_label, org, actor, member) => {
      const client = await app();
      const rows = await within(
        client,
        org,
        actor,
        async () => (await remove(client, member)).rowCount,
      );
      expect(rows).toBe(0);
    });

    it('takes the member project roles and pending invitations, and clears their keys', async () => {
      const client = await app();
      const seen = await within(client, ORG_A, OWNER_1.user, async () => {
        await client.query(
          `insert into app.project_roles (organization_id, membership_id, target_project_id, role)
           values ($1, $2, $3, 'editor')`,
          [ORG_A, ADMIN.member, PROJECT_A],
        );
        await client.query("select set_config('drefyn.actor_user_id', $1, true)", [ADMIN.user]);
        await client.query(
          `insert into app.invitations (organization_id, email_normalized, role, secret_hash, invited_by, expires_at)
           values ($1, 'new@example.com', 'member', decode(repeat('00', 32), 'hex'), $2, now() + interval '1 day')`,
          [ORG_A, ADMIN.member],
        );
        await client.query("select set_config('drefyn.actor_user_id', $1, true)", [OWNER_1.user]);
        await remove(client, ADMIN.member);
        const count = async (table: string) =>
          (await client.query<{ n: number }>(`select count(*)::int as n from app.${table}`)).rows[0]
            ?.n;
        return {
          roles: await count('project_roles'),
          invitations: await count('invitations'),
          creator: (
            await client.query<{ created_by: string | null }>(
              'select created_by from app.api_keys where id = $1',
              [KEY_A],
            )
          ).rows,
        };
      });
      expect(seen).toEqual({ roles: 0, invitations: 0, creator: [{ created_by: null }] });
    });
  });

  // The policy arm that wants another owner is the backstop; the code locks the
  // organization row first, and with the lock two demotions of the last two owners cannot
  // both pass.
  it('lets only one of two demotions of the last two owners commit when both take the lock', async () => {
    const one = await app();
    const two = await app();
    const begin = async (client: pg.Client, actor: string) => {
      await client.query('begin');
      await client.query("select set_config('drefyn.organization_id', $1, true)", [ORG_A]);
      await client.query("select set_config('drefyn.project_id', '', true)");
      await client.query("select set_config('drefyn.actor_user_id', $1, true)", [actor]);
      await client.query('select 1 from app.organizations where organization_id = $1 for update', [
        ORG_A,
      ]);
    };
    const ownersLeft = async (client: pg.Client) =>
      (
        await client.query<{ n: number }>(
          "select count(*)::int as n from app.memberships where role = 'owner'",
        )
      ).rows[0]?.n ?? 0;
    await begin(one, OWNER_1.user);
    const second = (async () => {
      await begin(two, OWNER_2.user);
      // Decided after the lock, as the code does: a fresh snapshot sees the first commit.
      if ((await ownersLeft(two)) < 2) {
        await two.query('rollback');
        return 'refused';
      }
      await setRole(two, OWNER_2.member, 'member');
      await two.query('rollback');
      return 'changed';
    })();
    expect(await ownersLeft(one)).toBe(2);
    await setRole(one, OWNER_1.member, 'member');
    await one.query('commit');
    try {
      expect(await second).toBe('refused');
    } finally {
      await superuser(
        `update app.memberships set role = 'owner' where id = '${OWNER_1.member}';`,
        db.name,
      );
    }
  });

  describe('project roles', () => {
    const grant = (client: pg.Client, member: string, project: string, role: string) =>
      client.query(
        `insert into app.project_roles (organization_id, membership_id, target_project_id, role)
         values ($1, $2, $3, $4)
         on conflict (organization_id, membership_id, target_project_id)
         do update set role = excluded.role, updated_at = now()`,
        [ORG_A, member, project, role],
      );

    it.each([OWNER_1.user, ADMIN.user])(
      'lets an owner or admin grant and change one',
      async (actor) => {
        const client = await app();
        const roles = await within(client, ORG_A, actor, async () => {
          await grant(client, MEMBER.member, PROJECT_A, 'editor');
          await grant(client, MEMBER.member, PROJECT_A, 'admin');
          return (await client.query('select target_project_id, role from app.project_roles')).rows;
        });
        expect(roles).toEqual([{ target_project_id: PROJECT_A, role: 'admin' }]);
      },
    );

    it.each<[string, string]>([
      ['a member', MEMBER.user],
      ['nobody', ''],
      ['an owner of another organization', LONE_OWNER.user],
    ])('refuses a grant by %s with 42501', async (_label, actor) => {
      const client = await app();
      const code = await within(client, ORG_A, actor, () =>
        sqlState(grant(client, MEMBER.member, PROJECT_A, 'editor')),
      );
      expect(code).toBe('42501');
    });

    it('changes and deletes nothing for a member acting', async () => {
      const client = await app();
      const seen = await within(client, ORG_A, OWNER_1.user, async () => {
        await grant(client, OTHER.member, PROJECT_A, 'viewer');
        await client.query("select set_config('drefyn.actor_user_id', $1, true)", [MEMBER.user]);
        const changed = (await client.query("update app.project_roles set role = 'admin'"))
          .rowCount;
        const deleted = (await client.query('delete from app.project_roles')).rowCount;
        return { changed, deleted };
      });
      expect(seen).toEqual({ changed: 0, deleted: 0 });
    });

    it('refuses an unknown role, a project of another organization and a repointed row', async () => {
      const client = await app();
      expect(
        await within(client, ORG_A, OWNER_1.user, () =>
          sqlState(grant(client, MEMBER.member, PROJECT_A, 'owner')),
        ),
      ).toBe('23514');
      expect(
        await within(client, ORG_A, OWNER_1.user, () =>
          sqlState(grant(client, MEMBER.member, PROJECT_B, 'viewer')),
        ),
      ).toBe('23503');
      expect(
        await within(client, ORG_A, OWNER_1.user, async () => {
          await grant(client, MEMBER.member, PROJECT_A, 'viewer');
          return sqlState(
            client.query('update app.project_roles set target_project_id = $1', [PROJECT_A2]),
          );
        }),
      ).toBe('42501');
    });

    it('goes with its project', async () => {
      const client = await app();
      const left = await within(client, ORG_A, OWNER_1.user, async () => {
        await grant(client, MEMBER.member, PROJECT_A, 'viewer');
        await grant(client, MEMBER.member, PROJECT_A2, 'editor');
        await client.query('delete from app.projects where id = $1', [PROJECT_A]);
        return (await client.query('select target_project_id from app.project_roles')).rows;
      });
      expect(left).toEqual([{ target_project_id: PROJECT_A2 }]);
    });

    it('reaches no row of another organization', async () => {
      const client = await app();
      const seen = await within(client, ORG_B, LONE_OWNER.user, async () => {
        await client.query(
          `insert into app.project_roles (organization_id, membership_id, target_project_id, role)
           values ($1, $2, $3, 'viewer')`,
          [ORG_B, LONE_OWNER.member, PROJECT_B],
        );
        await client.query("select set_config('drefyn.organization_id', $1, true)", [ORG_A]);
        return (await client.query('select 1 from app.project_roles')).rowCount;
      });
      expect(seen).toBe(0);
    });
  });

  // The new member guard already binds both rows to the person acting, so two owners in one
  // statement cannot pass: one is someone else, and the same person twice is a duplicate.
  it('refuses two owners inserted by one statement into a new organization', async () => {
    const client = await app();
    const fresh = id(3);
    for (const [second, code] of [
      [OTHER.user, '42501'],
      [OWNER_1.user, '23505'],
    ] as const) {
      const got = await within(client, fresh, OWNER_1.user, async () => {
        await client.query(
          `insert into app.organizations (organization_id, name, plan_tier) values ($1, 'x', 'self_hosted')`,
          [fresh],
        );
        return sqlState(
          client.query(
            `insert into app.memberships (organization_id, user_id, role)
             values ($1, $2, 'owner'), ($1, $3, 'owner')`,
            [fresh, OWNER_1.user, second],
          ),
        );
      });
      expect(got, second).toBe(code);
    }
  });

  // The tables hold a few rows, so sequential scans are turned off; the question is whether
  // an index serves each probe at all.
  it('plans an index scan for the actor, the other owner, the key delete and the invitation delete', async () => {
    const client = await app();
    const plan = await within(client, ORG_A, OWNER_1.user, async () => {
      await client.query('set local enable_seqscan = off');
      const explain = async (text: string) =>
        (await client.query<{ 'QUERY PLAN': string }>(`explain (costs off) ${text}`)).rows
          .map((r) => r['QUERY PLAN'])
          .join('\n');
      // The delete guard holds both probes in USING, which explain prints; WITH CHECK
      // subqueries are not shown.
      return {
        removal: await explain(`delete from app.memberships where id = '${OWNER_2.member}'`),
        keys: await explain(`delete from app.api_keys where created_by = '${ADMIN.member}'`),
        invitations: await explain(
          `delete from app.invitations where invited_by = '${ADMIN.member}'`,
        ),
      };
    });
    expect(plan.removal).toContain('memberships_organization_user_key');
    expect(plan.removal).toContain('memberships_owner_idx');
    expect(plan.keys).toContain('api_keys_created_by_idx');
    expect(plan.invitations).toContain('invitations_invited_by_idx');
    for (const text of Object.values(plan)) expect(text).not.toContain('Seq Scan');
  });

  it.each([
    'membership_update_actor',
    'membership_delete_actor',
    'project_role_insert_actor',
    'project_role_update_actor',
    'project_role_delete_actor',
  ])('carries %s with the exact text the allow list reviews', async (policy) => {
    const text = await superuser(
      `set search_path = pg_catalog;
       select coalesce(pg_get_expr(polqual, polrelid), '-') || E'\\n---\\n' ||
              coalesce(pg_get_expr(polwithcheck, polrelid), '-')
         from pg_policy where polname = '${policy}' and not polpermissive;`,
      db.name,
    );
    const entry = RESTRICTIVE_POLICIES.find((p) => p.name.endsWith(`.${policy}`));
    expect(text.trim()).toBe(`${entry?.using ?? '-'}\n---\n${entry?.withCheck ?? '-'}`);
  });

  it('passes check:catalog', async () => {
    expect(await catalogProblems(db.owner, ALLOW_LISTS)).toEqual([]);
  });
});
