import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { organizationId, projectId, type OrganizationRef, type TenantRef } from '@drefyn/tenancy';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { beforeAll, expect, it } from 'vitest';
import {
  closeDatabase,
  createDatabase,
  withTenant,
  type Database,
  type Schema,
} from '../../src/index.ts';
import { DbError } from '../../src/errors.ts';
import { rejected } from '../support.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { until } from './support/process.ts';
import {
  appConfig,
  backendsOf,
  context,
  fixtureTemplate,
  one,
  pools,
  rows,
  seed,
  seedProject,
} from './support/tenancy.ts';

const dbs = databases();
const fixture = fixtureTemplate(dbs);
const open = pools();

const ORG_A = organizationId('01a14984-4476-77ce-9335-10000000000a');
const ORG_B = organizationId('01a14984-4476-77ce-9335-10000000000b');
const PRJ_A1 = projectId('01a14984-4476-77ce-9335-1000000000a1');
const PRJ_B1 = projectId('01a14984-4476-77ce-9335-1000000000b1');
const A: OrganizationRef = { organizationId: ORG_A };
const A1: TenantRef = { organizationId: ORG_A, projectId: PRJ_A1 };
const B: OrganizationRef = { organizationId: ORG_B };
const B1: TenantRef = { organizationId: ORG_B, projectId: PRJ_B1 };

// The session scoped call the source check bans, kept in its fixture so no source file holds it.
const LEAK_PROJECT = readFileSync(
  join(import.meta.dirname, '..', 'fixtures', 'session-settings', 'bad', 'leak_project.sql'),
  'utf8',
).trim();

const bodies = sql<{ body: string }>`select body from app.fixture_notes order by body`;

let db: TestDatabase;
// One connection, so every transaction below reuses the same backend.
let single: Database;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function idle(pid: number): Promise<void> {
  const mine = (await backendsOf('drefyn_app', db.name)).find((b) => b.pid === pid);
  expect(mine, `backend ${String(pid)}`).toBeDefined();
  expect(mine?.state).toBe('idle');
}

describeWithStack('tenant context on a reused pooled connection', () => {
  beforeAll(async () => {
    db = await fixture();
    await seedProject(db.app, ORG_A, PRJ_A1);
    await seedProject(db.app, ORG_B, PRJ_B1);
    await seed(db.app, ORG_A, PRJ_A1, [
      {
        text: "insert into app.fixture_notes (organization_id, project_id, body) values ($1, $2, 'a1')",
        values: [ORG_A, PRJ_A1],
      },
    ]);
    await seed(db.app, ORG_B, PRJ_B1, [
      {
        text: "insert into app.fixture_notes (organization_id, project_id, body) values ($1, $2, 'b1')",
        values: [ORG_B, PRJ_B1],
      },
    ]);
    single = await open.app(db.app, { DREFYN_DATABASE_POOL_MAX: '1' });
  });

  it('runs every transaction on the one backend and leaves it idle, out of any transaction', async () => {
    const first = await withTenant(single, A1, (tx) => one(tx, context));
    const second = await withTenant(single, B, (tx) => one(tx, context));
    expect(second.pid).toBe(first.pid);
    await idle(first.pid);
  });

  it('starts the next transaction with only its own context', async () => {
    const a = await withTenant(single, A1, (tx) => one(tx, context));
    const b = await withTenant(single, B, (tx) => one(tx, context));
    expect(b.pid).toBe(a.pid);
    expect(a).toMatchObject({ org: ORG_A, project: PRJ_A1 });
    // The project from the last transaction must not carry over to an organization one.
    expect(b).toMatchObject({ org: ORG_B, project: null });
    expect(await withTenant(single, B, (tx) => rows(tx, bodies))).toEqual([{ body: 'b1' }]);
  });

  it('starts clean after work that threw', async () => {
    const before = await withTenant(single, A1, (tx) => one(tx, context));
    await rejected(
      withTenant(single, A1, () => {
        throw new Error('boom');
      }),
    );
    const after = await withTenant(single, B, (tx) => one(tx, context));
    expect(after).toMatchObject({ pid: before.pid, org: ORG_B, project: null });
    await idle(before.pid);
  });

  it('starts clean after a SQL error rolled the transaction back', async () => {
    const error = await rejected(withTenant(single, A1, (tx) => sql`select 1 / 0`.execute(tx)));
    expect(error).toBeInstanceOf(Error);
    const after = await withTenant(single, B, (tx) => one(tx, context));
    expect(after).toMatchObject({ org: ORG_B, project: null });
    await idle(after.pid);
  });

  it('starts clean after a policy violation', async () => {
    await rejected(
      withTenant(single, A1, (tx) =>
        sql`insert into app.fixture_notes (organization_id, project_id, body) values (${ORG_B}, ${PRJ_B1}, 'x')`.execute(
          tx,
        ),
      ),
    );
    expect(await withTenant(single, B1, (tx) => rows(tx, bodies))).toEqual([{ body: 'b1' }]);
  });

  // The work can still call the banned session form at run time; the next transaction must
  // not inherit it, which is why the project is set even when it is empty.
  it('ignores a session setting the work left behind', async () => {
    await withTenant(single, A1, (tx) =>
      sql.raw(LEAK_PROJECT.replace('$1', `'${PRJ_A1}'`)).execute(tx),
    );
    const next = await withTenant(single, A, (tx) => one(tx, context));
    expect(next).toMatchObject({ org: ORG_A, project: null });
    const other = await withTenant(single, B, (tx) => rows(tx, bodies));
    expect(other).toEqual([{ body: 'b1' }]);
  });

  it('sets the statement timeout per transaction, with the configured default', async () => {
    const timeout = sql<{ statement_timeout: string }>`show statement_timeout`;
    expect(await withTenant(single, A, (tx) => one(tx, timeout), { timeoutMs: 1500 })).toEqual({
      statement_timeout: '1500ms',
    });
    expect(await withTenant(single, A, (tx) => one(tx, timeout))).toEqual({
      statement_timeout: '5s',
    });
  });

  it('times out a slow statement with DB_TIMEOUT and leaves the connection usable', async () => {
    const error = await rejected(
      withTenant(single, A, (tx) => sql`select pg_sleep(30)`.execute(tx), { timeoutMs: 50 }),
    );
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe('DB_TIMEOUT');
    const after = await withTenant(single, B, (tx) => one(tx, context));
    expect(after).toMatchObject({ org: ORG_B, project: null });
    await idle(after.pid);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'refuses a timeout of %s before running anything',
    async (ms) => {
      let ran = false;
      const error = await rejected(
        withTenant(
          single,
          A,
          () => {
            ran = true;
            return Promise.resolve(1);
          },
          { timeoutMs: ms },
        ),
      );
      expect((error as DbError).code).toBe('DB_CONFIG_INVALID');
      expect(ran).toBe(false);
    },
  );

  // Kysely keeps the transaction object usable after its connection went back to the pool.
  it('refuses a transaction used after withTenant returned', async () => {
    let leaked: Transaction<Schema> | undefined;
    await withTenant(single, A1, (tx) => {
      leaked = tx;
      return Promise.resolve();
    });
    if (leaked === undefined) throw new Error('no transaction');
    const escaped = leaked;
    const started = deferred();
    const hold = deferred();
    // The next transaction holds the same connection with another tenant's context.
    const busy = withTenant(single, B1, async (tx) => {
      started.resolve();
      await hold.promise;
      return rows(tx, bodies);
    });
    await started.promise;
    const error = await rejected(rows(escaped, bodies));
    hold.resolve();
    expect(error).toBeInstanceOf(Error);
    expect(await busy).toEqual([{ body: 'b1' }]);
  });

  it('refuses a transaction used after its work threw', async () => {
    let leaked: Transaction<Schema> | undefined;
    await rejected(
      withTenant(single, A1, (tx) => {
        leaked = tx;
        throw new Error('boom');
      }),
    );
    if (leaked === undefined) throw new Error('no transaction');
    expect(await rejected(rows(leaked, bodies))).toBeInstanceOf(Error);
  });

  it('keeps concurrent transactions on separate connections apart', async () => {
    const wide = await open.app(db.app, { DREFYN_DATABASE_POOL_MAX: '4' });
    const refs = [A1, B1, A, B, A1, B1, A, B, A1, B1, A, B];
    const seen = await Promise.all(
      refs.map((ref) =>
        withTenant(wide, ref, async (tx) => {
          const first = await one(tx, context);
          const found = await rows(tx, bodies);
          const last = await one(tx, context);
          return { ref, first, found, last };
        }),
      ),
    );
    for (const { ref, first, found, last } of seen) {
      const project = 'projectId' in ref ? ref.projectId : null;
      expect(first).toMatchObject({ org: ref.organizationId, project });
      expect(last).toMatchObject({ org: ref.organizationId, project });
      expect(found).toEqual([{ body: ref.organizationId === ORG_A ? 'a1' : 'b1' }]);
    }
  });

  it('fails with DB_UNAVAILABLE when the pool stays busy past its wait', async () => {
    const tight = await open.app(db.app, {
      DREFYN_DATABASE_POOL_MAX: '1',
      DREFYN_DATABASE_POOL_WAIT_MS: '200',
    });
    const hold = deferred();
    const holding = withTenant(tight, A, () => hold.promise);
    let ran = false;
    const error = await rejected(
      withTenant(tight, B, () => {
        ran = true;
        return Promise.resolve(1);
      }),
    );
    hold.resolve();
    await holding;
    expect((error as DbError).code).toBe('DB_UNAVAILABLE');
    expect(ran).toBe(false);
    await expect(withTenant(tight, B, (tx) => rows(tx, bodies))).resolves.toEqual([{ body: 'b1' }]);
  });

  it('replaces the int8 parser on its own pool only', async () => {
    expect(
      await withTenant(single, A, (tx) => one(tx, sql<{ n: unknown }>`select 42::bigint as n`)),
    ).toEqual({ n: 42 });
    // Everything else in the process keeps the driver default.
    const parse = pg.types.getTypeParser(pg.types.builtins.INT8, 'text') as (
      text: string,
    ) => unknown;
    expect(parse('9007199254740993')).toBe('9007199254740993');
  });

  it('closes cleanly, refuses work after close and can close twice', async () => {
    const own = await createDatabase(appConfig(db.app, { DREFYN_DATABASE_POOL_MAX: '1' }));
    const { pid } = await withTenant(own, A, (tx) => one(tx, context));
    await closeDatabase(own);
    await closeDatabase(own);
    const error = await rejected(withTenant(own, A, () => Promise.resolve(1)));
    expect((error as DbError).code).toBe('DB_UNAVAILABLE');
    await until(async () => !(await backendsOf('drefyn_app', db.name)).some((b) => b.pid === pid), {
      timeoutMs: 5000,
      what: `backend ${String(pid)} to go after close`,
    });
  });
});
