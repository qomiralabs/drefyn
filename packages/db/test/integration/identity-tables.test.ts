import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { query } from './support/sql.ts';
import { superuser } from './support/stack.ts';
import { failure, rawSession } from './support/tenancy.ts';

const dbs = databases();

const USER_A = '01a14984-4476-77ce-9335-1280000000a1';
const USER_B = '01a14984-4476-77ce-9335-1280000000b1';
const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const HASH = Buffer.alloc(32, 7);

let db: TestDatabase;
const sessions: pg.Client[] = [];

async function as(role: 'app' | 'auth'): Promise<pg.Client> {
  const client = await rawSession(role, db.name);
  sessions.push(client);
  return client;
}

// Runs the statements in one transaction with drefyn.user_id set, then rolls back, so each
// case starts from the same rows.
async function asUser<T>(client: pg.Client, user: string, work: () => Promise<T>): Promise<T> {
  await client.query('begin');
  try {
    await client.query("select set_config('drefyn.user_id', $1, true)", [user]);
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

// Users exist only once the auth role inserts them, the same path sign up takes.
async function seedUsers(): Promise<void> {
  const auth = await as('auth');
  for (const [id, email] of [
    [USER_A, 'a@example.com'],
    [USER_B, 'b@example.com'],
  ] as const) {
    await auth.query(
      `insert into app.users (id, email, email_normalized, display_name, email_verified_at)
       values ($1, $2, $2, 'Person', now())`,
      [id, email],
    );
  }
}

describeWithStack('identity tables', () => {
  beforeAll(async () => {
    db = await dbs.fresh('migrated');
    await seedUsers();
  });

  afterAll(async () => {
    for (const client of sessions.splice(0)) await client.end().catch(() => undefined);
  });

  describe('users column grants for drefyn_app', () => {
    it.each(['email', 'email_normalized', 'email_verified_at'])(
      'refuses an update of %s with permission denied',
      async (column) => {
        const app = await as('app');
        const value = column === 'email_verified_at' ? 'now()' : "'x@example.com'";
        const code = await asUser(app, USER_A, () =>
          sqlState(app.query(`update app.users set ${column} = ${value} where id = $1`, [USER_A])),
        );
        expect(code).toBe('42501');
      },
    );

    it.each(['email_normalized', 'email_verified_at', 'updated_at'])(
      'refuses a read of %s with permission denied',
      async (column) => {
        const app = await as('app');
        const code = await asUser(app, USER_A, () =>
          sqlState(app.query(`select ${column} from app.users`)),
        );
        expect(code).toBe('42501');
      },
    );

    it('refuses select * and any insert', async () => {
      const app = await as('app');
      expect(await asUser(app, USER_A, () => sqlState(app.query('select * from app.users')))).toBe(
        '42501',
      );
      expect(
        await asUser(app, USER_A, () =>
          sqlState(
            app.query(
              `insert into app.users (email, email_normalized, email_verified_at)
               values ('c@example.com', 'c@example.com', now())`,
            ),
          ),
        ),
      ).toBe('42501');
    });

    it('reads the granted columns of its own row only and updates its display name', async () => {
      const app = await as('app');
      const seen = await asUser(app, USER_A, async () => {
        const read = await app.query<{ id: string; email: string }>(
          'select id, email, display_name, created_at from app.users order by id',
        );
        const updated = await app.query(
          "update app.users set display_name = 'Renamed', updated_at = now() where id in ($1, $2)",
          [USER_A, USER_B],
        );
        return { ids: read.rows.map((r) => r.id), updated: updated.rowCount };
      });
      expect(seen).toEqual({ ids: [USER_A], updated: 1 });
    });

    it('sees no user without a user context', async () => {
      const app = await as('app');
      const read = await app.query('select id from app.users');
      expect(read.rows).toEqual([]);
    });
  });

  describe('users column grants for drefyn_auth', () => {
    it('updates the address columns and nothing else', async () => {
      const auth = await as('auth');
      await auth.query('begin');
      try {
        const ok = await auth.query(
          `update app.users set email = 'a2@example.com', email_normalized = 'a2@example.com',
             email_verified_at = now(), updated_at = now() where id = $1`,
          [USER_A],
        );
        expect(ok.rowCount).toBe(1);
      } finally {
        await auth.query('rollback');
      }
      expect(
        await sqlState(
          auth.query("update app.users set display_name = 'x' where id = $1", [USER_A]),
        ),
      ).toBe('42501');
      expect(
        await sqlState(
          auth.query('update app.users set created_at = now() where id = $1', [USER_A]),
        ),
      ).toBe('42501');
      expect(await sqlState(auth.query('delete from app.users where id = $1', [USER_A]))).toBe(
        '42501',
      );
    });

    it('cannot insert a user with a chosen created_at', async () => {
      const auth = await as('auth');
      expect(
        await sqlState(
          auth.query(
            `insert into app.users (email, email_normalized, email_verified_at, created_at)
             values ('d@example.com', 'd@example.com', now(), now())`,
          ),
        ),
      ).toBe('42501');
    });

    it('refuses a second user with the same normalized address', async () => {
      const auth = await as('auth');
      expect(
        await sqlState(
          auth.query(
            `insert into app.users (email, email_normalized, email_verified_at)
             values ('A@example.com', 'a@example.com', now())`,
          ),
        ),
      ).toBe('23505');
    });
  });

  describe('table privileges', () => {
    it.each(['email_challenges', 'oauth_states', 'auth_rate_limits'])(
      'gives drefyn_app nothing on %s',
      async (table) => {
        const rows = await query<{ privilege: string; held: boolean; columns: boolean }>(
          db.owner,
          `select p as privilege, has_table_privilege('drefyn_app', 'app.${table}', p) as held,
                  has_any_column_privilege('drefyn_app', 'app.${table}', 'SELECT, INSERT, UPDATE') as columns
             from unnest($1::text[]) p`,
          [PRIVILEGES],
        );
        expect(rows.filter((r) => r.held || r.columns)).toEqual([]);
      },
    );

    it.each(['sessions', 'api_key_failures'])('gives drefyn_auth nothing on %s', async (table) => {
      const rows = await query<{ privilege: string; held: boolean; columns: boolean }>(
        db.owner,
        `select p as privilege, has_table_privilege('drefyn_auth', 'app.${table}', p) as held,
                has_any_column_privilege('drefyn_auth', 'app.${table}', 'SELECT, INSERT, UPDATE') as columns
           from unnest($1::text[]) p`,
        [PRIVILEGES],
      );
      expect(rows.filter((r) => r.held || r.columns)).toEqual([]);
    });

    it('gives drefyn_app exactly select, insert, update and delete on api_key_failures', async () => {
      const rows = await query<{ privilege: string }>(
        db.owner,
        `select p as privilege from unnest($1::text[]) p
          where has_table_privilege('drefyn_app', 'app.api_key_failures', p) order by 1`,
        [PRIVILEGES],
      );
      expect(rows.map((r) => r.privilege)).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    });

    it('stores no address or IP in clear in either limiter table', async () => {
      const rows = await query<{ table: string; column: string; type: string }>(
        db.owner,
        `select c.relname as table, a.attname as column, format_type(a.atttypid, a.atttypmod) as type
           from pg_attribute a join pg_class c on c.oid = a.attrelid
          where c.relnamespace = 'app'::regnamespace
            and c.relname in ('auth_rate_limits', 'api_key_failures')
            and a.attnum > 0 and not a.attisdropped
          order by 1, a.attnum`,
      );
      expect(rows).toEqual([
        { table: 'api_key_failures', column: 'key_hmac', type: 'bytea' },
        { table: 'api_key_failures', column: 'window_start', type: 'timestamp with time zone' },
        { table: 'api_key_failures', column: 'window_end', type: 'timestamp with time zone' },
        { table: 'api_key_failures', column: 'count', type: 'integer' },
        { table: 'auth_rate_limits', column: 'bucket', type: 'text' },
        { table: 'auth_rate_limits', column: 'key_hmac', type: 'bytea' },
        { table: 'auth_rate_limits', column: 'window_start', type: 'timestamp with time zone' },
        { table: 'auth_rate_limits', column: 'window_end', type: 'timestamp with time zone' },
        { table: 'auth_rate_limits', column: 'count', type: 'integer' },
      ]);
    });
  });

  describe('check constraints', () => {
    const challenge = (purpose: string, user: string | null) =>
      `insert into app.email_challenges
         (email_normalized, purpose, user_id, code_hmac, browser_hash, expires_at)
       values ('a@example.com', '${purpose}', ${user === null ? 'null' : `'${user}'`}, $1, $1,
               now() + interval '10 minutes')`;

    it('refuses an email_change challenge without a user_id', async () => {
      const auth = await as('auth');
      expect(await sqlState(auth.query(challenge('email_change', null), [HASH]))).toBe('23514');
    });

    it('accepts an email_change challenge with a user_id and a sign in challenge without', async () => {
      const auth = await as('auth');
      await auth.query('begin');
      try {
        await auth.query(challenge('email_change', USER_A), [HASH]);
        await auth.query(challenge('sign_in', null), [HASH]);
      } finally {
        await auth.query('rollback');
      }
    });

    it('refuses an unknown challenge purpose', async () => {
      const auth = await as('auth');
      expect(await sqlState(auth.query(challenge('sign_up', null), [HASH]))).toBe('23514');
    });

    it('refuses more than 5 attempts on a challenge', async () => {
      const auth = await as('auth');
      await auth.query('begin');
      try {
        const id = await auth.query<{ id: string }>(`${challenge('sign_in', null)} returning id`, [
          HASH,
        ]);
        expect(
          await sqlState(
            auth.query('update app.email_challenges set attempts = 6 where id = $1', [
              id.rows[0]?.id,
            ]),
          ),
        ).toBe('23514');
      } finally {
        await auth.query('rollback');
      }
    });

    const session = (stepUp: string | null) =>
      `insert into app.sessions
         (user_id, secret_hash, method, step_up_method, authenticated_at, expires_at)
       values ($1, $2, 'email', ${stepUp === null ? 'null' : `'${stepUp}'`}, now(),
               now() + interval '30 days')`;

    it.each([null, 'email', 'password', 'google', 'github_session'])(
      'accepts step_up_method %s',
      async (stepUp) => {
        const app = await as('app');
        await asUser(app, USER_A, () => app.query(session(stepUp), [USER_A, HASH]));
      },
    );

    it.each(['github', 'sms', ''])('refuses step_up_method %j', async (stepUp) => {
      const app = await as('app');
      const code = await asUser(app, USER_A, () =>
        sqlState(app.query(session(stepUp), [USER_A, HASH])),
      );
      expect(code).toBe('23514');
    });

    it('refuses a session secret hash that is not 32 bytes', async () => {
      const app = await as('app');
      const code = await asUser(app, USER_A, () =>
        sqlState(app.query(session(null), [USER_A, Buffer.alloc(31)])),
      );
      expect(code).toBe('23514');
    });

    it('refuses a session for another user under a user context', async () => {
      const app = await as('app');
      const code = await asUser(app, USER_A, () =>
        sqlState(app.query(session(null), [USER_B, HASH])),
      );
      expect(code).toBe('42501');
    });
  });

  describe('password_credentials', () => {
    it('lets the person write their own hash and the auth role read and rehash it', async () => {
      const app = await as('app');
      await app.query('begin');
      await app.query("select set_config('drefyn.user_id', $1, true)", [USER_B]);
      await app.query('insert into app.password_credentials (user_id, phc) values ($1, $2)', [
        USER_B,
        '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
      ]);
      expect(
        await sqlState(
          app.query('insert into app.password_credentials (user_id, phc) values ($1, $2)', [
            USER_A,
            'x',
          ]),
        ),
      ).toBe('42501');
      await app.query('rollback');
    });

    it('refuses drefyn_auth an insert and drefyn_app a chosen created_at', async () => {
      const auth = await as('auth');
      expect(
        await sqlState(
          auth.query('insert into app.password_credentials (user_id, phc) values ($1, $2)', [
            USER_A,
            'x',
          ]),
        ),
      ).toBe('42501');
      const app = await as('app');
      const code = await asUser(app, USER_A, () =>
        sqlState(
          app.query(
            'insert into app.password_credentials (user_id, phc, created_at) values ($1, $2, now())',
            [USER_A, 'x'],
          ),
        ),
      );
      expect(code).toBe('42501');
    });
  });

  describe('cascades', () => {
    it('removes identities, sessions, credentials and challenges with the user', async () => {
      const clone = await dbs.fresh('migrated');
      const auth = await rawSession('auth', clone.name);
      const app = await rawSession('app', clone.name);
      sessions.push(auth, app);
      await auth.query(
        `insert into app.users (id, email, email_normalized, email_verified_at)
         values ($1, 'gone@example.com', 'gone@example.com', now())`,
        [USER_A],
      );
      await auth.query(
        `insert into app.identities (user_id, provider, provider_subject, provider_email_normalized)
         values ($1, 'github', '123', 'gone@example.com')`,
        [USER_A],
      );
      await auth.query(
        `insert into app.email_challenges
           (email_normalized, purpose, user_id, code_hmac, browser_hash, expires_at)
         values ('new@example.com', 'email_change', $1, $2, $2, now() + interval '10 minutes')`,
        [USER_A, HASH],
      );
      await app.query('begin');
      await app.query("select set_config('drefyn.user_id', $1, true)", [USER_A]);
      await app.query(session(null), [USER_A, HASH]);
      await app.query('insert into app.password_credentials (user_id, phc) values ($1, $2)', [
        USER_A,
        'x',
      ]);
      await app.query('commit');
      // Account deletion is a later flow; the superuser stands in for it here, and also counts
      // past row level security.
      await superuser(`delete from app.users where id = '${USER_A}';`, clone.name);
      const left = await superuser(
        `select (select count(*) from app.identities) + (select count(*) from app.sessions)
              + (select count(*) from app.password_credentials)
              + (select count(*) from app.email_challenges);`,
        clone.name,
      );
      expect(left.trim()).toBe('0');
    });

    const session = (stepUp: string | null) =>
      `insert into app.sessions
         (user_id, secret_hash, method, step_up_method, authenticated_at, expires_at)
       values ($1, $2, 'email', ${stepUp === null ? 'null' : `'${stepUp}'`}, now(),
               now() + interval '30 days')`;
  });
});
