import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALLOW_LISTS, type AllowLists } from '../../src/allow-lists.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { superuser } from './support/stack.ts';
import { catalogProblems, failure, rawSession } from './support/tenancy.ts';

const dbs = databases();

const USER_A = '01a14984-4476-77ce-9335-1280000002a1';
const USER_B = '01a14984-4476-77ce-9335-1280000002b1';
const ORG = '01a14984-4476-77ce-9335-1280000002f1';

const TABLES = ['totp_credentials', 'recovery_codes', 'factor_challenges'] as const;
type Table = (typeof TABLES)[number];

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

const bytes = (n: number, length: number) =>
  `decode(lpad(to_hex(${String(n)}), ${String(length * 2)}, '0'), 'hex')`;

// One valid row per table for a user, as SQL values in column order.
const ROW: Record<Table, { columns: string; values: (user: string, n: number) => string }> = {
  totp_credentials: {
    columns: 'user_id, key_id, secret_nonce, secret_sealed',
    values: (user, n) => `'${user}', 'k1', ${bytes(n, 12)}, ${bytes(n, 36)}`,
  },
  recovery_codes: {
    columns: 'user_id, code_hash',
    values: (user, n) => `'${user}', ${bytes(n, 32)}`,
  },
  factor_challenges: {
    columns: 'user_id, secret_hash, method, expires_at',
    values: (user, n) => `'${user}', ${bytes(n, 32)}, 'password', now() + interval '10 minutes'`,
  },
};

const insertSql = (table: Table, user: string, n: number) =>
  `insert into app.${table} (${ROW[table].columns}) values (${ROW[table].values(user, n)})`;

async function seedUser(id: string, email: string): Promise<void> {
  await superuser(
    `insert into app.users (id, email, email_normalized, email_verified_at)
       values ('${id}', '${email}', '${email}', now());`,
    db.name,
  );
}

async function seedRows(user: string, n: number): Promise<void> {
  await superuser(TABLES.map((t) => `${insertSql(t, user, n)};`).join('\n'), db.name);
}

const count = async (table: Table, user: string) =>
  (await superuser(`select count(*) from app.${table} where user_id = '${user}';`, db.name)).trim();

describeWithStack('second factor tables', () => {
  beforeAll(async () => {
    db = await dbs.fresh('migrated');
    await seedUser(USER_A, 'sf-a@example.com');
    await seedUser(USER_B, 'sf-b@example.com');
    await seedRows(USER_A, 1);
    await seedRows(USER_B, 2);
  });

  afterAll(async () => {
    for (const client of sessions.splice(0)) await client.end().catch(() => undefined);
  });

  describe('catalog', () => {
    it.each(TABLES)('forces row level security on %s', async (table) => {
      const flags = await superuser(
        `select relrowsecurity::text || ',' || relforcerowsecurity::text
           from pg_class where oid = 'app.${table}'::regclass;`,
        db.name,
      );
      expect(flags.trim()).toBe('true,true');
    });

    // A stolen sign in credential must read no sealed secret and no recovery hash, and still
    // cannot reach anything that would let it mint a session.
    it.each(TABLES)('gives drefyn_auth no privilege at all on %s', async (table) => {
      const privileges = await superuser(
        `select string_agg(p || '=' || has_table_privilege('drefyn_auth', 'app.${table}', p)::text, ',' order by p)
           from unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p;`,
        db.name,
      );
      expect(privileges.trim()).toBe(
        'delete=false,insert=false,references=false,select=false,trigger=false,truncate=false,update=false',
      );
      const columns = await superuser(
        `select count(*) from information_schema.column_privileges
          where table_schema = 'app' and table_name = '${table}' and grantee = 'drefyn_auth';`,
        db.name,
      );
      expect(columns.trim()).toBe('0');
      const client = await as('auth');
      const read = await rolledBack(client, () =>
        sqlState(client.query(`select user_id from app.${table}`)),
      );
      expect(read).toBe('42501');
    });

    // Organization work sets an organization and an actor, never a user, so self_access
    // matches nothing even when the actor owns rows here.
    it.each(TABLES)('lets the organization context read none of %s', async (table) => {
      const client = await as('app');
      await client.query('begin');
      try {
        await client.query(
          `select set_config('drefyn.organization_id', $1, true), set_config('drefyn.project_id', '', true),
                  set_config('drefyn.user_id', '', true), set_config('drefyn.actor_user_id', $2, true)`,
          [ORG, USER_A],
        );
        const read = await client.query(`select user_id from app.${table}`);
        expect(read.rowCount).toBe(0);
      } finally {
        await client.query('rollback');
      }
    });

    it.each(TABLES)(
      'grants drefyn_app no table level select, insert or update on %s',
      async (t) => {
        const table = await superuser(
          `select coalesce(string_agg(privilege_type, ',' order by privilege_type), '')
           from information_schema.table_privileges
          where table_schema = 'app' and table_name = '${t}' and grantee = 'drefyn_app';`,
          db.name,
        );
        expect(table.trim()).toBe('DELETE');
      },
    );

    it('passes the catalog check, and fails without each allow list entry', async () => {
      expect(await catalogProblems(db.owner, ALLOW_LISTS)).toEqual([]);
      for (const table of TABLES) {
        const name = `app.${table}`;
        const global: AllowLists = {
          ...ALLOW_LISTS,
          globalTables: ALLOW_LISTS.globalTables.filter((e) => e.name !== name),
        };
        expect(await catalogProblems(db.owner, global)).toContainEqual(
          expect.objectContaining({ rule: 'tenant_column', object: name }),
        );
        const policies: AllowLists = {
          ...ALLOW_LISTS,
          userPolicies: ALLOW_LISTS.userPolicies.filter((p) => p.name !== `${name}.self_access`),
        };
        const policy = await catalogProblems(db.owner, policies);
        expect(
          policy.some((p) => p.object.startsWith(name)),
          name,
        ).toBe(true);
        const columns: AllowLists = {
          ...ALLOW_LISTS,
          columnGrants: ALLOW_LISTS.columnGrants.filter((g) => !g.name.startsWith(`${name}.`)),
        };
        const grant = await catalogProblems(db.owner, columns);
        expect(grant, name).toContainEqual(
          expect.objectContaining({ rule: 'column_grant', object: name }),
        );
      }
    });
  });

  describe('a person reaches only their own rows', () => {
    it.each(TABLES)('in %s', async (table) => {
      const client = await as('app');
      const own = await rolledBack(
        client,
        () => client.query(`select user_id from app.${table}`),
        USER_A,
      );
      expect(own.rows).toEqual([{ user_id: USER_A }]);

      const none = await rolledBack(client, () => client.query(`select 1 from app.${table}`));
      expect(none.rowCount).toBe(0);

      const deleted = await rolledBack(
        client,
        () => client.query(`delete from app.${table} where user_id = $1`, [USER_B]),
        USER_A,
      );
      expect(deleted.rowCount).toBe(0);

      const foreign = await rolledBack(
        client,
        () => sqlState(client.query(insertSql(table, USER_B, 9))),
        USER_A,
      );
      expect(foreign).toBe('42501');
      expect(await count(table, USER_B)).toBe('1');
    });

    it('updates no other person row, and cannot move a row to them', async () => {
      const client = await as('app');
      const touched = await rolledBack(
        client,
        () =>
          client.query('update app.recovery_codes set used_at = now() where user_id = $1', [
            USER_B,
          ]),
        USER_A,
      );
      expect(touched.rowCount).toBe(0);
      const attempts = await rolledBack(
        client,
        () => client.query('update app.factor_challenges set attempts = 1'),
        USER_A,
      );
      expect(attempts.rowCount).toBe(1);
      const failed = await rolledBack(
        client,
        () => client.query('update app.totp_credentials set failed_attempts = 3'),
        USER_A,
      );
      expect(failed.rowCount).toBe(1);
      expect(
        (
          await superuser(
            `select failed_attempts from app.totp_credentials where user_id = '${USER_B}';`,
            db.name,
          )
        ).trim(),
      ).toBe('0');
    });

    it('lets a person insert and delete their own rows', async () => {
      const client = await as('app');
      for (const table of TABLES) {
        const done = await rolledBack(
          client,
          async () => {
            await client.query(`delete from app.${table}`);
            const inserted = await client.query(insertSql(table, USER_A, 7));
            const left = await client.query(`select count(*)::int as n from app.${table}`);
            return { inserted: inserted.rowCount, left: left.rows[0] as { n: number } };
          },
          USER_A,
        );
        expect(done, table).toEqual({ inserted: 1, left: { n: 1 } });
      }
    });
  });

  describe('grants', () => {
    const UPDATABLE: Record<Table, readonly string[]> = {
      totp_credentials: [
        'key_id',
        'secret_nonce',
        'secret_sealed',
        'last_used_step',
        'failed_attempts',
        'confirmed_at',
        'last_used_at',
        'updated_at',
      ],
      recovery_codes: ['used_at'],
      factor_challenges: ['attempts'],
    };
    // A value each column accepts, so a refusal can only be the grant.
    const VALUE: Readonly<Record<string, string>> = {
      user_id: `'${USER_A}'`,
      id: 'uuidv7()',
      key_id: "'k2'",
      secret_nonce: bytes(5, 12),
      secret_sealed: bytes(5, 36),
      last_used_step: '1',
      failed_attempts: '1',
      confirmed_at: 'now()',
      last_used_at: 'now()',
      created_at: 'now()',
      updated_at: 'now()',
      code_hash: bytes(5, 32),
      used_at: 'now()',
      secret_hash: bytes(5, 32),
      method: "'email'",
      return_to: "'/'",
      attempts: '1',
      expires_at: 'now()',
    };

    it.each(TABLES)('lets drefyn_app update only the listed columns of %s', async (table) => {
      const all = (
        await superuser(
          `select string_agg(column_name, ',' order by ordinal_position)
             from information_schema.columns where table_schema = 'app' and table_name = '${table}';`,
          db.name,
        )
      )
        .trim()
        .split(',');
      const client = await as('app');
      for (const column of all) {
        const value = VALUE[column];
        expect(value, column).toBeDefined();
        const code = await rolledBack(
          client,
          () => sqlState(client.query(`update app.${table} set ${column} = ${value ?? 'null'}`)),
          USER_A,
        );
        expect(code, `${table}.${column}`).toBe(
          UPDATABLE[table].includes(column) ? 'no error' : '42501',
        );
      }
    });

    // Only attempts can change, so replacing a challenge is a delete then an insert. Two sign
    // ins racing to insert must not both win: the loser fails on the key, never overwrites.
    it('fails closed when two challenges for one person are inserted at once', async () => {
      const id = '01a14984-4476-77ce-9335-1280000002c1';
      await seedUser(id, 'sf-c@example.com');
      const first = await as('app');
      const second = await as('app');
      for (const client of [first, second]) {
        await client.query('begin');
        await client.query("select set_config('drefyn.user_id', $1, true)", [id]);
        await client.query('delete from app.factor_challenges');
      }
      await first.query(insertSql('factor_challenges', id, 11));
      // The second insert waits on the first row's key until the first commits.
      const racing = sqlState(second.query(insertSql('factor_challenges', id, 12)));
      await first.query('commit');
      expect(await racing).toBe('23505');
      await second.query('rollback');
      const kept = await superuser(
        `select encode(secret_hash, 'hex') from app.factor_challenges where user_id = '${id}';`,
        db.name,
      );
      expect(kept.trim()).toBe('b'.padStart(64, '0'));
    });
  });

  describe('column checks', () => {
    // Inside a transaction that never commits, so a check that wrongly passes changes nothing.
    const refused = async (sql: string) => {
      const code = await sqlState(superuser(`begin; ${sql} rollback;`, db.name));
      expect(code, sql).not.toBe('no error');
    };
    const totp = (key: string, nonce: number, sealed: number, failed = 0) =>
      `insert into app.totp_credentials (user_id, key_id, secret_nonce, secret_sealed, failed_attempts)
         values ('${USER_A}', ${key}, ${bytes(1, nonce)}, ${bytes(1, sealed)}, ${String(failed)})
         on conflict (user_id) do nothing;
       select 'inserted';`;

    it('accepts the boundary values', async () => {
      const ok = await superuser(
        `begin;
         delete from app.totp_credentials where user_id = '${USER_A}';
         ${totp("'abcdefg8'", 12, 36, 100)}
         delete from app.factor_challenges where user_id = '${USER_A}';
         insert into app.factor_challenges (user_id, secret_hash, method, attempts, return_to, expires_at)
           values ('${USER_A}', ${bytes(1, 32)}, 'cli_link', 5, repeat('a', 2048), now());
         rollback;`,
        db.name,
      );
      expect(ok).toContain('inserted');
    });

    it.each(["''", "'ABC'", "'abcdefghi'", "'a-b'", "'k 1'"])('refuses key_id %s', async (key) => {
      await refused(`delete from app.totp_credentials; ${totp(key, 12, 36)}`);
    });

    it.each([11, 13])('refuses a nonce of %d bytes', async (nonce) => {
      await refused(`delete from app.totp_credentials; ${totp("'k1'", nonce, 36)}`);
    });

    it.each([35, 37])('refuses a sealed secret of %d bytes', async (sealed) => {
      await refused(`delete from app.totp_credentials; ${totp("'k1'", 12, sealed)}`);
    });

    it.each([101, -1])('refuses failed_attempts of %d', async (failed) => {
      await refused(`delete from app.totp_credentials; ${totp("'k1'", 12, 36, failed)}`);
    });

    it.each([6, -1])('refuses challenge attempts of %d', async (attempts) => {
      await refused(
        `update app.factor_challenges set attempts = ${String(attempts)} where user_id = '${USER_A}';`,
      );
    });

    it('refuses a recovery hash or challenge hash that is not 32 bytes', async () => {
      await refused(
        `insert into app.recovery_codes (user_id, code_hash) values ('${USER_A}', ${bytes(1, 31)});`,
      );
      await refused(
        `update app.factor_challenges set secret_hash = ${bytes(1, 33)} where user_id = '${USER_A}';`,
      );
    });

    it('refuses an unknown challenge method and a return_to over 2048 characters', async () => {
      await refused(
        `update app.factor_challenges set method = 'totp' where user_id = '${USER_A}';`,
      );
      await refused(
        `update app.factor_challenges set return_to = repeat('a', 2049) where user_id = '${USER_A}';`,
      );
    });
  });

  it('removes every second factor row with the user', async () => {
    const id = '01a14984-4476-77ce-9335-1280000002d1';
    await seedUser(id, 'sf-d@example.com');
    await seedRows(id, 21);
    await superuser(
      `insert into app.recovery_codes (user_id, code_hash) values ('${id}', ${bytes(22, 32)});`,
      db.name,
    );
    expect(await count('recovery_codes', id)).toBe('2');
    await superuser(`delete from app.users where id = '${id}';`, db.name);
    for (const table of TABLES) expect(await count(table, id), table).toBe('0');
    for (const table of TABLES) expect(await count(table, USER_A), table).toBe('1');
  });

  describe('sessions', () => {
    const insertSession = (stepUp: string) =>
      `insert into app.sessions (user_id, secret_hash, method, step_up_method, authenticated_at, expires_at)
         values ('${USER_A}', ${bytes(3, 32)}, 'password', '${stepUp}', now(), now() + interval '1 day');`;

    it('names the step up check as the migration expects', async () => {
      const name = await superuser(
        `select conname from pg_constraint
          where conrelid = 'app.sessions'::regclass and contype = 'c'
            and pg_get_constraintdef(oid) like '%step_up_method%';`,
        db.name,
      );
      expect(name.trim()).toBe('sessions_step_up_method_check');
    });

    it.each(['email', 'password', 'google', 'github_session', 'totp', 'recovery_code'])(
      'accepts step_up_method %s',
      async (stepUp) => {
        const code = await sqlState(superuser(`begin; ${insertSession(stepUp)}`, db.name));
        expect(code).toBe('no error');
      },
    );

    it.each(['sms', 'github', 'cli_link', ''])(
      'still refuses step_up_method %j',
      async (stepUp) => {
        const code = await sqlState(superuser(`begin; ${insertSession(stepUp)}`, db.name));
        expect(code).not.toBe('no error');
      },
    );
  });
});
