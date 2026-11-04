import type pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ALLOW_LISTS, type AllowLists } from '../../src/allow-lists.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { superuser } from './support/stack.ts';
import { catalogProblems, failure, rawSession } from './support/tenancy.ts';

const dbs = databases();

const USER_A = '01a14984-4476-77ce-9335-1280000001a1';
const USER_B = '01a14984-4476-77ce-9335-1280000001b1';

let db: TestDatabase;
const sessions: pg.Client[] = [];

async function as(role: 'app' | 'auth'): Promise<pg.Client> {
  const client = await rawSession(role, db.name);
  sessions.push(client);
  return client;
}

async function sqlState(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return failure(error).code ?? 'unknown';
  }
  return 'no error';
}

// Each case rolls back, so every case sees the seeded rows.
async function rolledBack<T>(client: pg.Client, work: () => Promise<T>, user?: string): Promise<T> {
  await client.query('begin');
  try {
    if (user !== undefined) {
      await client.query("select set_config('drefyn.user_id', $1, true)", [user]);
    }
    return await work();
  } finally {
    await client.query('rollback');
  }
}

const hash = (n: number) => `decode(lpad(to_hex(${String(n)}), 64, '0'), 'hex')`;

describeWithStack('cli_sign_in_links', () => {
  beforeAll(async () => {
    db = await dbs.fresh('migrated');
    await superuser(
      `insert into app.users (id, email, email_normalized, email_verified_at) values
         ('${USER_A}', 'cl-a@example.com', 'cl-a@example.com', now()),
         ('${USER_B}', 'cl-b@example.com', 'cl-b@example.com', now());
       insert into app.cli_sign_in_links (user_id, secret_hash, expires_at) values
         ('${USER_A}', ${hash(1)}, now() + interval '15 minutes'),
         ('${USER_B}', ${hash(2)}, now() + interval '15 minutes');`,
      db.name,
    );
  });

  afterAll(async () => {
    for (const client of sessions.splice(0)) await client.end().catch(() => undefined);
  });

  it('gives drefyn_app no privilege at all, even under a user context', async () => {
    const privileges = await superuser(
      `select string_agg(p || '=' || has_table_privilege('drefyn_app', 'app.cli_sign_in_links', p)::text, ',' order by p)
         from unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p;`,
      db.name,
    );
    expect(privileges.trim()).toBe(
      'delete=false,insert=false,references=false,select=false,trigger=false,truncate=false,update=false',
    );
    const columns = await superuser(
      `select count(*) from information_schema.column_privileges
        where table_schema = 'app' and table_name = 'cli_sign_in_links' and grantee = 'drefyn_app';`,
      db.name,
    );
    expect(columns.trim()).toBe('0');
    const client = await as('app');
    const read = await rolledBack(
      client,
      () => sqlState(client.query('select 1 from app.cli_sign_in_links')),
      USER_A,
    );
    expect(read).toBe('42501');
  });

  it('lets drefyn_auth select, insert and delete, and update consumed_at only', async () => {
    const client = await as('auth');
    const seen = await rolledBack(client, () =>
      client.query('select user_id from app.cli_sign_in_links order by user_id'),
    );
    expect(seen.rowCount).toBe(2);
    const inserted = await rolledBack(client, () =>
      client.query(
        `insert into app.cli_sign_in_links (user_id, secret_hash, expires_at) values ($1, ${hash(3)}, now() + interval '15 minutes')`,
        [USER_A],
      ),
    );
    expect(inserted.rowCount).toBe(1);
    const consumed = await rolledBack(client, () =>
      client.query(
        `update app.cli_sign_in_links set consumed_at = now() where secret_hash = ${hash(1)} returning user_id`,
      ),
    );
    expect(consumed.rows).toEqual([{ user_id: USER_A }]);
    for (const column of ['expires_at', 'user_id', 'secret_hash', 'created_at']) {
      const value = column === 'expires_at' || column === 'created_at' ? 'now()' : 'null';
      const code = await rolledBack(client, () =>
        sqlState(client.query(`update app.cli_sign_in_links set ${column} = ${value}`)),
      );
      expect(code, column).toBe('42501');
    }
    const deleted = await rolledBack(client, () =>
      client.query('delete from app.cli_sign_in_links where user_id = $1', [USER_B]),
    );
    expect(deleted.rowCount).toBe(1);
  });

  it('refuses a hash that is not 32 bytes and the same hash twice', async () => {
    const short = await sqlState(
      superuser(
        `insert into app.cli_sign_in_links (user_id, secret_hash, expires_at) values ('${USER_A}', '\\x00', now());`,
        db.name,
      ),
    );
    expect(short).not.toBe('no error');
    const twice = await sqlState(
      superuser(
        `insert into app.cli_sign_in_links (user_id, secret_hash, expires_at) values ('${USER_B}', ${hash(1)}, now());`,
        db.name,
      ),
    );
    expect(twice).not.toBe('no error');
  });

  it('goes with the user', async () => {
    const id = '01a14984-4476-77ce-9335-1280000001c1';
    await superuser(
      `insert into app.users (id, email, email_normalized, email_verified_at)
         values ('${id}', 'cl-c@example.com', 'cl-c@example.com', now());
       insert into app.cli_sign_in_links (user_id, secret_hash, expires_at)
         values ('${id}', ${hash(9)}, now());
       delete from app.users where id = '${id}';`,
      db.name,
    );
    const left = await superuser(
      `select count(*) from app.cli_sign_in_links where secret_hash = ${hash(9)};`,
      db.name,
    );
    expect(left.trim()).toBe('0');
  });

  it('passes the catalog check with its allow list entries and fails without each', async () => {
    expect(await catalogProblems(db.owner, ALLOW_LISTS)).toEqual([]);
    const without = (key: 'globalTables' | 'authTables' | 'authOnlyTables'): AllowLists => ({
      ...ALLOW_LISTS,
      [key]: ALLOW_LISTS[key].filter((entry) => entry.name !== 'app.cli_sign_in_links'),
    });
    const global = await catalogProblems(db.owner, without('globalTables'));
    expect(global).toContainEqual(
      expect.objectContaining({ rule: 'tenant_column', object: 'app.cli_sign_in_links' }),
    );
    const auth = await catalogProblems(db.owner, without('authTables'));
    expect(auth.some((p) => p.object === 'app.cli_sign_in_links')).toBe(true);
    const policies: AllowLists = {
      ...ALLOW_LISTS,
      userPolicies: ALLOW_LISTS.userPolicies.filter(
        (p) => p.name !== 'app.cli_sign_in_links.auth_access',
      ),
    };
    const policy = await catalogProblems(db.owner, policies);
    expect(policy.some((p) => p.object.startsWith('app.cli_sign_in_links'))).toBe(true);
  });
});
