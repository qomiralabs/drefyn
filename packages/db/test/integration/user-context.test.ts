import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { organizationId, projectId, userId, type UserRef } from '@drefyn/tenancy';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { databaseOverPool } from '../../src/database.ts';
import {
  withAuth,
  withOrganization,
  withTenant,
  withUser,
  type AuthDatabase,
  type Database,
} from '../../src/index.ts';
import { rejected } from '../support.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { query } from './support/sql.ts';
import {
  authUrl,
  failure,
  fixtureTemplate,
  one,
  pools,
  rows,
  seed,
  seedProject,
  settings,
} from './support/tenancy.ts';

const dbs = databases();
const fixture = fixtureTemplate(dbs);
const open = pools();

const ORG = organizationId('01a14984-4476-77ce-9335-12700000000a');
const PRJ = projectId('01a14984-4476-77ce-9335-1270000000a1');
const USR = userId('01a14984-4476-77ce-9335-1270000000f1');
const OTHER = userId('01a14984-4476-77ce-9335-1270000000f2');
const USER: UserRef = { userId: USR };

// The session scoped call the source check bans, kept in its fixture so no source file holds it.
const LEAK_USER = readFileSync(
  join(import.meta.dirname, '..', 'fixtures', 'session-settings', 'bad', 'leak_project.sql'),
  'utf8',
)
  .trim()
  .replace('drefyn.project_id', 'drefyn.user_id')
  .replace('$1', `'${OTHER}'`);

const currentUser = sql<{ user_id: string | null; pid: number }>`
  select app.current_user_id()::text as user_id, pg_backend_pid() as pid`;

let db: TestDatabase;
let single: Database;
let auth: AuthDatabase;

describeWithStack('user and auth contexts', () => {
  beforeAll(async () => {
    db = await fixture();
    await seedProject(db.app, ORG, PRJ);
    await seed(db.app, ORG, null, [
      {
        text: "insert into app.fixture_members (organization_id, email) values ($1, 'a@example.com')",
        values: [ORG],
      },
    ]);
    single = await open.app(db.app, { DREFYN_DATABASE_POOL_MAX: '1' });
    auth = await open.auth(authUrl(db));
  });

  it('app.current_user_id() returns the user inside withUser', async () => {
    const row = await withUser(single, USER, (tx) => one(tx, settings));
    expect(row).toMatchObject({ org: '', project: '', user_id: USR, who: 'drefyn_app' });
    expect((await withUser(single, USER, (tx) => one(tx, currentUser))).user_id).toBe(USR);
  });

  it('app.current_user_id() is null under a tenant, an organization and a bare session', async () => {
    const tenant = await withTenant(single, { organizationId: ORG, projectId: PRJ }, (tx) =>
      one(tx, currentUser),
    );
    const organization = await withOrganization(single, { organizationId: ORG }, (tx) =>
      one(tx, currentUser),
    );
    expect(tenant.user_id).toBeNull();
    expect(organization.user_id).toBeNull();
    expect(await query(db.app, 'select app.current_user_id() as user_id')).toEqual([
      { user_id: null },
    ]);
  });

  // No organization is set, so tenant_isolation lets nothing through.
  it('reads no tenant rows under a user context', async () => {
    const members = sql<{ email: string }>`select email from app.fixture_members`;
    const notes = sql<{ body: string }>`select body from app.fixture_notes`;
    expect(await withUser(single, USER, (tx) => rows(tx, members))).toEqual([]);
    expect(await withUser(single, USER, (tx) => rows(tx, notes))).toEqual([]);
    expect(
      await withOrganization(single, { organizationId: ORG }, (tx) => rows(tx, members)),
    ).toEqual([{ email: 'a@example.com' }]);
  });

  it('starts the next transaction on the same backend without the user', async () => {
    const first = await withUser(single, USER, (tx) => one(tx, currentUser));
    const next = await withOrganization(single, { organizationId: ORG }, (tx) =>
      one(tx, currentUser),
    );
    expect(next.pid).toBe(first.pid);
    expect(next.user_id).toBeNull();
  });

  it('refuses work that switches the user inside the transaction', async () => {
    const error = await rejected(
      withUser(single, USER, async (tx) => {
        await sql`select set_config('drefyn.user_id', ${OTHER}, true)`.execute(tx);
      }),
    );
    expect((error as { code?: unknown }).code).toBe('DB_TRANSACTION_INVALID');
  });

  it('runs withAuth as drefyn_auth with no tenant and no user', async () => {
    const row = await withAuth(auth, (tx) => one(tx, settings));
    expect(row).toMatchObject({ org: '', project: '', user_id: '', who: 'drefyn_auth' });
  });

  it('gives drefyn_auth no reach into tenant tables or the context readers', async () => {
    for (const statement of [
      sql`select count(*) from app.fixture_members`,
      sql`select count(*) from app.fixture_notes`,
      sql`select app.current_user_id()`,
      sql`select app.current_org()`,
    ]) {
      const error = await rejected(withAuth(auth, (tx) => statement.execute(tx)));
      expect(failure(error).code).toBe('42501');
    }
  });
});

// The handle is built over a pool the test can also reach directly, so the released
// connection can be read outside any transaction.
describeWithStack('a connection released after withUser', () => {
  let pool: pg.Pool;
  let raw: Database;

  beforeAll(async () => {
    const own = await fixture();
    pool = new pg.Pool({ connectionString: own.app, max: 1 });
    raw = databaseOverPool(pool, 'app', { statementTimeoutMs: 5000 }) as Database;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function afterRelease(): Promise<{ user_id: string | null; pid: number }> {
    const client = await pool.connect();
    try {
      const { rows: found } = await client.query<{ user_id: string | null; pid: number }>(
        "select current_setting('drefyn.user_id', true) as user_id, pg_backend_pid() as pid",
      );
      const row = found[0];
      if (row === undefined) throw new Error('expected a row');
      return row;
    } finally {
      client.release();
    }
  }

  it('no longer has drefyn.user_id set', async () => {
    const inside = await withUser(raw, USER, (tx) => one(tx, currentUser));
    const after = await afterRelease();
    expect(after.pid).toBe(inside.pid);
    expect(after.user_id ?? '').toBe('');
  });

  // Only the reset can clear a session value the work left behind.
  it('drops a session value of drefyn.user_id the work left behind', async () => {
    const inside = await withUser(raw, USER, async (tx) => {
      await sql.raw(LEAK_USER).execute(tx);
      return one(tx, currentUser);
    });
    const after = await afterRelease();
    expect(after.pid).toBe(inside.pid);
    expect(after.user_id ?? '').toBe('');
  });
});
