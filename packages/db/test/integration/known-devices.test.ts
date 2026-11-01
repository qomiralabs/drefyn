import type pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  AUTH_EXPIRY_RULES,
  createExpiryCleanup,
  deleteExpired,
  withAuth,
  type AuthDatabase,
} from '../../src/index.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { superuser } from './support/stack.ts';
import { authUrl, failure, pools, rawSession } from './support/tenancy.ts';

const dbs = databases();
const open = pools();

const USER_A = '01a14984-4476-77ce-9335-1280000000c1';
const USER_B = '01a14984-4476-77ce-9335-1280000000d1';

let db: TestDatabase;
let auth: AuthDatabase;
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

// Each case runs in a transaction it rolls back, so every case sees the seeded rows.
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

const device = (n: number) => `decode(lpad(to_hex(${String(n)}), 64, '0'), 'hex')`;

async function seed(): Promise<void> {
  await superuser(
    `insert into app.users (id, email, email_normalized, email_verified_at) values
       ('${USER_A}', 'kd-a@example.com', 'kd-a@example.com', now()),
       ('${USER_B}', 'kd-b@example.com', 'kd-b@example.com', now());
     insert into app.known_devices (user_id, device_hash, user_agent_family, last_seen_at) values
       ('${USER_A}', ${device(1)}, 'Firefox on Linux', now() - interval '401 days'),
       ('${USER_A}', ${device(2)}, 'Safari on macOS', now() - interval '399 days'),
       ('${USER_B}', ${device(3)}, 'Chrome on Windows', now());`,
    db.name,
  );
}

const count = async (where = 'true') =>
  (await superuser(`select count(*) from app.known_devices where ${where};`, db.name)).trim();

describeWithStack('known_devices', () => {
  beforeAll(async () => {
    db = await dbs.fresh('migrated');
    auth = await open.auth(authUrl(db));
    await seed();
  });

  afterAll(async () => {
    for (const client of sessions.splice(0)) await client.end().catch(() => undefined);
  });

  it('lets drefyn_auth delete a 401 day old row', async () => {
    const client = await as('auth');
    const deleted = await rolledBack(client, async () =>
      client.query(
        `delete from app.known_devices where last_seen_at < now() - interval '400 days'`,
      ),
    );
    expect(deleted.rowCount).toBe(1);
  });

  it('never lets drefyn_auth delete a fresher row, even with no filter', async () => {
    const client = await as('auth');
    const deleted = await rolledBack(client, () => client.query('delete from app.known_devices'));
    expect(deleted.rowCount).toBe(1);
    expect(await count()).toBe('3');
  });

  it('lets drefyn_auth read only user_id, device_hash, last_seen_at and ctid', async () => {
    const client = await as('auth');
    const read = await rolledBack(client, () =>
      client.query('select ctid, user_id, device_hash, last_seen_at from app.known_devices'),
    );
    expect(read.rowCount).toBe(3);
    for (const column of ['user_agent_family', 'created_at', 'id', '*']) {
      const code = await rolledBack(client, () =>
        sqlState(client.query(`select ${column} from app.known_devices`)),
      );
      expect(code).toBe('42501');
    }
  });

  it('refuses drefyn_auth any insert or update', async () => {
    const client = await as('auth');
    const insert = await rolledBack(client, () =>
      sqlState(
        client.query(
          `insert into app.known_devices (user_id, device_hash, user_agent_family) values ($1, ${device(9)}, 'x')`,
          [USER_A],
        ),
      ),
    );
    expect(insert).toBe('42501');
    const update = await rolledBack(client, () =>
      sqlState(client.query('update app.known_devices set last_seen_at = now()')),
    );
    expect(update).toBe('42501');
  });

  it('lets drefyn_app reach its own devices only, under a user context', async () => {
    const client = await as('app');
    const own = await rolledBack(
      client,
      () => client.query('select user_agent_family from app.known_devices order by 1'),
      USER_A,
    );
    expect(own.rows.map((r: { user_agent_family: string }) => r.user_agent_family)).toEqual([
      'Firefox on Linux',
      'Safari on macOS',
    ]);
    const none = await rolledBack(client, () => client.query('select 1 from app.known_devices'));
    expect(none.rowCount).toBe(0);
    const foreign = await rolledBack(
      client,
      () =>
        sqlState(
          client.query(
            `insert into app.known_devices (user_id, device_hash, user_agent_family) values ($1, ${device(8)}, 'x')`,
            [USER_B],
          ),
        ),
      USER_A,
    );
    expect(foreign).toBe('42501');
    const mine = await rolledBack(
      client,
      async () => {
        await client.query(
          `insert into app.known_devices (user_id, device_hash, user_agent_family) values ($1, ${device(7)}, 'Firefox on Linux')`,
          [USER_A],
        );
        await client.query(
          `update app.known_devices set last_seen_at = now() where device_hash = ${device(7)}`,
        );
        return client.query(`delete from app.known_devices where device_hash = ${device(7)}`);
      },
      USER_A,
    );
    expect(mine.rowCount).toBe(1);
  });

  it('refuses a device hash that is not 32 bytes and a second row for one device', async () => {
    const short = await sqlState(
      superuser(
        `insert into app.known_devices (user_id, device_hash, user_agent_family) values ('${USER_A}', '\\x00', 'x');`,
        db.name,
      ),
    );
    expect(short).not.toBe('no error');
    const twice = await sqlState(
      superuser(
        `insert into app.known_devices (user_id, device_hash, user_agent_family) values ('${USER_A}', ${device(1)}, 'x');`,
        db.name,
      ),
    );
    expect(twice).not.toBe('no error');
  });

  it('goes with the user', async () => {
    await superuser(
      `insert into app.users (id, email, email_normalized, email_verified_at) values
         ('01a14984-4476-77ce-9335-1280000000e1', 'kd-e@example.com', 'kd-e@example.com', now());
       insert into app.known_devices (user_id, device_hash, user_agent_family)
         values ('01a14984-4476-77ce-9335-1280000000e1', ${device(5)}, 'x');
       delete from app.users where id = '01a14984-4476-77ce-9335-1280000000e1';`,
      db.name,
    );
    expect(await count(`device_hash = ${device(5)}`)).toBe('0');
  });

  it('is in the auth expiry rules at 400 days', () => {
    expect(AUTH_EXPIRY_RULES).toContainEqual({
      table: 'known_devices',
      column: 'last_seen_at',
      afterSeconds: 400 * 86_400,
    });
  });

  it('the expiry cleanup deletes stale device rows through withAuth and keeps fresh ones', async () => {
    const cleanup = createExpiryCleanup({
      rules: AUTH_EXPIRY_RULES,
      transact: (work) => withAuth(auth, work),
    });
    const counts = await cleanup.maybeRun();
    expect(counts?.['known_devices']).toBe(1);
    expect(await count()).toBe('2');
    expect(await count(`device_hash = ${device(1)}`)).toBe('0');
  });

  it('clears 5000 stale rows in one run inside the statement timeout', async () => {
    await superuser(
      `insert into app.users (id, email, email_normalized, email_verified_at)
         select ('01a14984-4476-77ce-9335-' || lpad(to_hex(g), 12, '0'))::uuid,
                'bulk' || g || '@example.com', 'bulk' || g || '@example.com', now()
           from generate_series(1, 5000) g;
       insert into app.known_devices (user_id, device_hash, user_agent_family, last_seen_at)
         select ('01a14984-4476-77ce-9335-' || lpad(to_hex(g), 12, '0'))::uuid,
                ${device(100000)}, 'x', now() - interval '401 days'
           from generate_series(1, 5000) g;`,
      db.name,
    );
    const rules = AUTH_EXPIRY_RULES.filter((r) => r.table === 'known_devices');
    const started = performance.now();
    const counts = await withAuth(auth, (tx) => deleteExpired(tx, rules));
    const ms = performance.now() - started;
    // Printed for the PR: one run at 5000 stale rows.
    console.info(
      `known_devices cleanup: ${String(counts['known_devices'])} rows in ${ms.toFixed(1)} ms`,
    );
    expect(counts['known_devices']).toBe(5000);
    expect(ms).toBeLessThan(2000);
  });
});
