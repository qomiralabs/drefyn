import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALLOW_LISTS, RESTRICTIVE_POLICIES, USER_POLICIES } from '../../src/allow-lists.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { superuser } from './support/stack.ts';
import { catalogProblems, failure, rawSession } from './support/tenancy.ts';

const dbs = databases();

const USER_A = '01a14984-4476-77ce-9335-1280000000a1';
const USER_B = '01a14984-4476-77ce-9335-1280000000b1';
const ORG_A = '01a14984-4476-77ce-9335-1280000001a1';
const ORG_B = '01a14984-4476-77ce-9335-1280000001b1';
const MEMBER_A = '01a14984-4476-77ce-9335-1280000003a1';
const MEMBER_B = '01a14984-4476-77ce-9335-1280000003b1';
// A plain member of organization A, added the way an invitation would, outside drefyn_app.
const PLAIN_A = '01a14984-4476-77ce-9335-1280000003c1';
const USER_C = '01a14984-4476-77ce-9335-1280000000c1';
const KEY_D = '01a14984-4476-77ce-9335-1280000004f1';
const PROJECT_A = '01a14984-4476-77ce-9335-1280000002a1';
const PROJECT_B = '01a14984-4476-77ce-9335-1280000002b1';
const KEY_A = '01a14984-4476-77ce-9335-1280000004a1';
const KEY_B = '01a14984-4476-77ce-9335-1280000004b1';
const KEY_C = '01a14984-4476-77ce-9335-1280000004e1';
const TABLES = ['api_keys', 'api_key_projects'];

let db: TestDatabase;
const sessions: pg.Client[] = [];

// One session per role and database, reused by every case: each case rolls back, and other
// files run beside this one, so a session per case runs the server out of connection slots.
const shared = new Map<string, pg.Client>();

async function as(role: 'app' | 'auth'): Promise<pg.Client> {
  const key = `${role}:${db.name}`;
  const held = shared.get(key);
  if (held !== undefined) return held;
  const client = await rawSession(role, db.name);
  client.on('error', () => undefined);
  sessions.push(client);
  shared.set(key, client);
  return client;
}

afterAll(async () => {
  shared.clear();
  for (const client of sessions.splice(0)) await client.end().catch(() => undefined);
});

// Runs under one organization and rolls back, so each case starts from the seeded rows.
async function within<T>(
  client: pg.Client,
  org: string,
  work: () => Promise<T>,
  actor = '',
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

// Two organizations, made the way creation makes them (install tier, first owner in the same
// transaction), each with an owner, a docs project and one key listed on that project.
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
    await app.query("select set_config('drefyn.actor_user_id', $1, true)", [user]);
    for (const text of [
      `insert into app.organizations (organization_id, name, plan_tier) values ('${org}', 'Org', 'self_hosted')`,
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
  await auth.query(
    `insert into app.users (id, email, email_normalized, email_verified_at)
     values ($1, 'c@example.com', 'c@example.com', now())`,
    [USER_C],
  );
  await superuser(
    `insert into app.memberships (id, organization_id, user_id, role)
     values ('${PLAIN_A}', '${ORG_A}', '${USER_C}', 'member');`,
    db.name,
  );
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
    expect(await within(app, ORG_A, () => sqlState(app.query(text)), USER_A)).toBe('23514');
  });

  it('hold one key per idempotency key in an organization', async () => {
    const app = await as('app');
    const again = keyInsert(ORG_A, '01a14984-4476-77ce-9335-1280000004d1', MEMBER_A).replace(
      "'k-01a14984-4476-77ce-9335-1280000004d1'",
      `'k-${KEY_A}'`,
    );
    expect(await within(app, ORG_A, () => sqlState(app.query(again)), USER_A)).toBe('23505');
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

  it('let organization work revoke a live key, once', async () => {
    const app = await as('app');
    const rows = await within(app, ORG_A, async () => {
      const first = await app.query(
        'update app.api_keys set revoked_at = now() where revoked_at is null',
      );
      const second = await app.query('update app.api_keys set revoked_at = now()');
      return [first.rowCount, second.rowCount];
    });
    expect(rows).toEqual([1, 0]);
  });

  it('refuse organization work deleting a key', async () => {
    const app = await as('app');
    expect(await within(app, ORG_A, () => sqlState(app.query('delete from app.api_keys')))).toBe(
      '42501',
    );
  });

  it.each([
    ['clearing the revoke time', 'revoked_at = null'],
    ['moving the revoke time', "revoked_at = now() + interval '1 day'"],
    ['recording a use', 'last_used_at = now()'],
  ])('leave a revoked key alone when %s', async (_name, assignment) => {
    const app = await as('app');
    const seen = await within(app, ORG_A, async () => {
      await app.query('update app.api_keys set revoked_at = now()');
      const changed = await app.query(`update app.api_keys set ${assignment}`);
      const row = await app.query<{ revoked: boolean; used: boolean }>(
        `select revoked_at = now() as revoked, last_used_at is not null as used
           from app.api_keys where id = '${KEY_A}'`,
      );
      return { changed: changed.rowCount, row: row.rows[0] };
    });
    expect(seen).toEqual({ changed: 0, row: { revoked: true, used: false } });
  });

  it('refuse to remove a creator whose key is live, since it would outlive them', async () => {
    const app = await as('app');
    const state = await within(
      app,
      ORG_A,
      async () => {
        await app.query(`update app.memberships set role = 'admin' where id = '${PLAIN_A}'`);
        await app.query("select set_config('drefyn.actor_user_id', $1, true)", [USER_C]);
        await app.query(keyInsert(ORG_A, KEY_D, PLAIN_A));
        await app.query("select set_config('drefyn.actor_user_id', $1, true)", [USER_A]);
        return sqlState(app.query(`delete from app.memberships where id = '${PLAIN_A}'`));
      },
      USER_A,
    );
    expect(state).toBe('23514');
  });

  // Made an admin, the plain member creates a key, and the owner then removes them.
  it("clear only the creator of a revoked key when the creator's membership goes", async () => {
    const app = await as('app');
    const seen = await within(
      app,
      ORG_A,
      async () => {
        await app.query(`update app.memberships set role = 'admin' where id = '${PLAIN_A}'`);
        await app.query("select set_config('drefyn.actor_user_id', $1, true)", [USER_C]);
        await app.query(keyInsert(ORG_A, KEY_D, PLAIN_A));
        await app.query("select set_config('drefyn.actor_user_id', $1, true)", [USER_A]);
        await app.query(`update app.api_keys set revoked_at = now() where id = '${KEY_D}'`);
        const removed = await app.query(`delete from app.memberships where id = '${PLAIN_A}'`);
        const row = await app.query<{ organization_id: string; created_by: string | null }>(
          `select organization_id, created_by from app.api_keys where id = '${KEY_D}'`,
        );
        return { removed: removed.rowCount, row: row.rows[0] };
      },
      USER_A,
    );
    expect(seen).toEqual({ removed: 1, row: { organization_id: ORG_A, created_by: null } });
  });

  it('give drefyn_auth no grant on the project rows of a key', async () => {
    const auth = await as('auth');
    expect(await sqlState(auth.query('select 1 from app.api_key_projects'))).toBe('42501');
  });

  it.each([
    'id',
    'organization_id',
    'name',
    'secret_hash',
    'display_suffix',
    'scopes',
    'project_scope',
    'created_by',
    'created_at',
    'expires_at',
    'last_used_at',
    'idempotency_key',
    'request_hash',
  ])('refuse drefyn_auth reading %s', async (column) => {
    const auth = await as('auth');
    expect(await sqlState(auth.query(`select ${column} from app.api_keys`))).toBe('42501');
  });

  it.each([
    ['insert', keyInsert(ORG_A, KEY_D, MEMBER_A)],
    ['update', 'update app.api_keys set revoked_at = null'],
    ['truncate', 'truncate app.api_keys'],
  ])('refuse drefyn_auth a %s', async (_name, text) => {
    const auth = await as('auth');
    expect(await sqlState(auth.query(text))).toBe('42501');
  });

  describe('as the expiry cleanup sees them', () => {
    const REVOKED_LONG_AGO = '01a14984-4476-77ce-9335-1280000005a1';
    const REVOKED_LATELY = '01a14984-4476-77ce-9335-1280000005a2';

    // Row dates are the database's to set, so these go in as the superuser. Each key sits on
    // one side of the 90 day line, beside the live key the seed made.
    beforeAll(async () => {
      await superuser(
        `insert into app.api_keys (id, organization_id, name, secret_hash, display_suffix, scopes,
           project_scope, created_by, idempotency_key, request_hash, created_at, revoked_at)
         select v.id::uuid, '${ORG_A}', 'CI', decode(repeat('ab', 32), 'hex'), 'a1b2',
                array['docs:read'], 'all', '${MEMBER_A}', 'k-' || v.id,
                decode(repeat('cd', 32), 'hex'), now() - interval '200 days', v.revoked_at
           from (values
             ('${REVOKED_LONG_AGO}', now() - interval '91 days'),
             ('${REVOKED_LATELY}', now() - interval '89 days')) v(id, revoked_at);`,
        db.name,
      );
    });

    afterAll(async () => {
      await superuser(
        `delete from app.api_keys where id in ('${REVOKED_LONG_AGO}', '${REVOKED_LATELY}');`,
        db.name,
      );
    });

    const asAuth = async <T>(work: (auth: pg.Client) => Promise<T>): Promise<T> => {
      const auth = await as('auth');
      await auth.query('begin');
      try {
        return await work(auth);
      } finally {
        await auth.query('rollback');
      }
    };

    it('show drefyn_auth only the rows past the limit', async () => {
      const count = await asAuth(
        async (auth) => (await auth.query('select revoked_at from app.api_keys')).rowCount,
      );
      expect(count).toBe(1);
    });

    it('let a delete as drefyn_auth with no filter remove only the rows past the limit', async () => {
      const seen = await asAuth(async (auth) => {
        const gone = await auth.query('delete from app.api_keys');
        return gone.rowCount;
      });
      expect(seen).toBe(1);
    });

    it('stop a delete as drefyn_auth aimed inside the limit or at a live key', async () => {
      const seen = await asAuth(async (auth) => {
        const lately = await auth.query(
          `delete from app.api_keys where revoked_at > now() - interval '90 days'`,
        );
        const live = await auth.query('delete from app.api_keys where revoked_at is null');
        return [lately.rowCount, live.rowCount];
      });
      expect(seen).toEqual([0, 0]);
    });

    it('keep drefyn_app from deleting a key past the limit', async () => {
      const app = await as('app');
      expect(
        await within(app, ORG_A, () =>
          sqlState(app.query(`delete from app.api_keys where id = '${REVOKED_LONG_AGO}'`)),
        ),
      ).toBe('42501');
    });
  });

  // Each case has the named person acting, so only the rule under test can refuse it.
  it.each<[string, () => string, string]>([
    [
      'no creator',
      () => keyInsert(ORG_A, KEY_D, MEMBER_A).replace(`'${MEMBER_A}'`, 'null'),
      USER_A,
    ],
    ['a plain member as creator', () => keyInsert(ORG_A, KEY_D, PLAIN_A), USER_C],
    ['a creator id that is no membership', () => keyInsert(ORG_A, KEY_D, KEY_A), USER_A],
    // Organization work cannot mint a key in the owner's name for someone else.
    ['the owner as creator while a member acts', () => keyInsert(ORG_A, KEY_D, MEMBER_A), USER_C],
    ['the owner as creator while nobody acts', () => keyInsert(ORG_A, KEY_D, MEMBER_A), ''],
    [
      'the owner as creator while an owner of another organization acts',
      () => keyInsert(ORG_A, KEY_D, MEMBER_A),
      USER_B,
    ],
  ])('refuse a key with %s, with permission denied', async (_name, text, actor) => {
    const app = await as('app');
    expect(await within(app, ORG_A, () => sqlState(app.query(text())), actor)).toBe('42501');
  });

  it("refuse another organization's owner as creator, even through organization_id", async () => {
    const app = await as('app');
    // The foreign key would also refuse it; the policy answers first.
    expect(
      await within(
        app,
        ORG_A,
        () => sqlState(app.query(keyInsert(ORG_A, KEY_D, MEMBER_B))),
        USER_B,
      ),
    ).toBe('42501');
  });

  it('let an owner or an admin of the organization create a key', async () => {
    const app = await as('app');
    expect(
      await within(
        app,
        ORG_A,
        () => sqlState(app.query(keyInsert(ORG_A, KEY_D, MEMBER_A))),
        USER_A,
      ),
    ).toBe('no error');
    await superuser(`update app.memberships set role = 'admin' where id = '${PLAIN_A}';`, db.name);
    try {
      expect(
        await within(
          app,
          ORG_A,
          () => sqlState(app.query(keyInsert(ORG_A, KEY_D, PLAIN_A))),
          USER_C,
        ),
      ).toBe('no error');
    } finally {
      await superuser(
        `update app.memberships set role = 'member' where id = '${PLAIN_A}';`,
        db.name,
      );
    }
  });

  it.each([['Docs read'], ['docs:Read'], ['blog:read'], ['docs:'], ['docs:read write']])(
    'refuse the stored scope %j',
    async (scope) => {
      const app = await as('app');
      const text = keyInsert(ORG_A, KEY_D, MEMBER_A).replace(
        "array['docs:read']",
        `array['${scope}']`,
      );
      expect(await within(app, ORG_A, () => sqlState(app.query(text)), USER_A)).toBe('23514');
    },
  );

  it('carry the creator guard with the exact text the allow list reviews', async () => {
    const text = await superuser(
      // The catalog check prints with search_path = pg_catalog, which keeps the app. prefix.
      `set search_path = pg_catalog;
       select pg_get_expr(polwithcheck, polrelid) from pg_policy
        where polname = 'api_key_insert_creator' and polrelid = 'app.api_keys'::regclass
          and not polpermissive;`,
      db.name,
    );
    const entry = RESTRICTIVE_POLICIES.find(
      (p) => p.name === 'app.api_keys.api_key_insert_creator',
    );
    expect(text.trim()).toBe(entry?.withCheck);
  });

  it('carry the revoke guard with the exact text the allow list reviews', async () => {
    const text = await superuser(
      `set search_path = pg_catalog;
       select pg_get_expr(polqual, polrelid) || '|' || pg_get_expr(polwithcheck, polrelid)
         from pg_policy
        where polname = 'api_key_update_unrevoked' and polrelid = 'app.api_keys'::regclass
          and not polpermissive;`,
      db.name,
    );
    const entry = RESTRICTIVE_POLICIES.find(
      (p) => p.name === 'app.api_keys.api_key_update_unrevoked',
    );
    expect(text.trim()).toBe(`${String(entry?.using)}|${String(entry?.withCheck)}`);
  });

  it.each(['auth_expire', 'auth_expire_read'])(
    'carry %s with the exact text the allow list reviews',
    async (name) => {
      const text = await superuser(
        `set search_path = pg_catalog;
         select pg_get_expr(polqual, polrelid) from pg_policy
          where polname = '${name}' and polrelid = 'app.api_keys'::regclass and polpermissive;`,
        db.name,
      );
      const entry = USER_POLICIES.find((p) => p.name === `app.api_keys.${name}`);
      expect(text.trim()).toBe(entry?.using);
    },
  );

  it('pass check:catalog', async () => {
    expect(await catalogProblems(db.owner, ALLOW_LISTS)).toEqual([]);
  });
});
