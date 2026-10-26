import { expect, it } from 'vitest';
import { NO_TRANSACTION_MARKER } from '../../src/migration-file.ts';
import {
  describeFailure,
  fixtureMigrations,
  migrate,
  migration,
  recordedName,
  startMigrate,
} from './support/cli.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { until } from './support/process.ts';
import { migrationState, query, session } from './support/sql.ts';
import { superuser } from './support/stack.ts';

const dbs = databases();

const TABLE = '9000000000001_widgets.sql';
const UNIQUE = '9000000000002_widgets_name_key.sql';

const table = migration(
  'create table app.widgets (id int primary key, name text not null);',
  'drop table app.widgets;',
);

const uniqueIndex = `${NO_TRANSACTION_MARKER}\n${migration(
  'create unique index concurrently if not exists widgets_name_key on app.widgets (name);',
  'drop index concurrently if exists app.widgets_name_key;',
)}`;

async function indexValid(url: string, qualified: string): Promise<boolean | null> {
  const rows = await query<{ valid: boolean | null }>(
    url,
    'select (select indisvalid from pg_index where indexrelid = to_regclass($1)) as valid',
    [qualified],
  );
  return rows[0]?.valid ?? null;
}

const recorded = async (db: TestDatabase, file: string) => {
  const state = await migrationState(db.owner);
  return {
    record: state?.applied.includes(recordedName(file)) ?? false,
    checksum: state?.checksums.some((c) => c.name === recordedName(file)) ?? false,
  };
};

// The table file applied, two rows that a unique index on name refuses.
async function withDuplicates(): Promise<{ db: TestDatabase; dir: string }> {
  const db = await dbs.fresh('base');
  const dir = fixtureMigrations({ [TABLE]: table, [UNIQUE]: uniqueIndex });
  const first = await migrate(['migrate', 'up'], {
    url: db.owner,
    migrationsDir: fixtureMigrations({ [TABLE]: table }),
  });
  expect(first.code, describeFailure(first)).toBe(0);
  await query(db.owner, "insert into app.widgets values (1, 'same'), (2, 'same')");
  return { db, dir };
}

// From the second up on: the invalid index stops every command until someone repairs it,
// and once repaired the file builds a valid index and is recorded.
async function expectStoppedThenRepaired(db: TestDatabase, dir: string): Promise<void> {
  expect(await indexValid(db.owner, 'app.widgets_name_key')).toBe(false);
  expect(await recorded(db, UNIQUE)).toEqual({ record: false, checksum: false });

  const second = await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir });
  expect(second.code, describeFailure(second)).toBe(4);
  expect(second.stderr).toContain('app.widgets_name_key on app.widgets');
  expect(second.stdout).not.toContain(recordedName(UNIQUE));
  expect(await recorded(db, UNIQUE)).toEqual({ record: false, checksum: false });
  expect(await indexValid(db.owner, 'app.widgets_name_key')).toBe(false);

  const status = await migrate(['migrate', 'status'], { url: db.owner, migrationsDir: dir });
  expect(status.code, describeFailure(status)).toBe(4);
  expect(status.stderr).toContain('app.widgets_name_key on app.widgets');

  // The repair the README gives: fix the cause, drop the index, run up again.
  await query(db.owner, 'delete from app.widgets where id = 2');
  await query(db.owner, 'drop index concurrently if exists app.widgets_name_key');
  const repaired = await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir });
  expect(repaired.code, describeFailure(repaired)).toBe(0);
  expect(await indexValid(db.owner, 'app.widgets_name_key')).toBe(true);
  expect(await recorded(db, UNIQUE)).toEqual({ record: true, checksum: true });
}

describeWithStack('invalid indexes left by a marked file', () => {
  it('stop the next up after a unique build fails on duplicate rows', async () => {
    const { db, dir } = await withDuplicates();
    const first = await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir });
    expect(first.code, describeFailure(first)).toBe(1);
    await expectStoppedThenRepaired(db, dir);
  });

  // An uncommitted insert makes the build wait for writers after its catalog entry exists,
  // which is the window an interrupted deploy leaves behind.
  it('stop the next up after a running build is cancelled', async () => {
    const { db, dir } = await withDuplicates();
    const writer = await session(db.owner);
    await writer.query('begin');
    await writer.query("insert into app.widgets values (3, 'other')");
    const run = startMigrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir });
    try {
      await until(
        async () => {
          const rows = await query<{ pid: number | null }>(
            db.owner,
            `select (select pid from pg_stat_activity
                      where application_name = 'drefyn-migrate' and wait_event_type = 'Lock'
                        and datname = current_database()) as pid`,
          );
          const pid = rows[0]?.pid ?? null;
          if (pid === null) return false;
          await query(db.owner, 'select pg_cancel_backend($1)', [pid]);
          return true;
        },
        { timeoutMs: 30_000, watching: run, what: 'the build waiting for writers' },
      );
    } finally {
      await writer.query('rollback');
      await writer.end();
    }
    const first = await run.done;
    expect(first.code, describeFailure(first)).toBe(1);
    await expectStoppedThenRepaired(db, dir);
  });
});

describeWithStack('invalid indexes from any cause', () => {
  // A cancelled reindex concurrently leaves its new copy behind as <index>_ccnew.
  it('stop up, down and status when a reindex left a _ccnew copy', async () => {
    const db = await dbs.fresh('migrated');
    await query(db.owner, 'create table app.gadgets (id int, name text)');
    await query(db.owner, 'create index gadgets_name_idx on app.gadgets (name)');
    const writer = await session(db.owner);
    const reindexer = await session(db.owner);
    await writer.query('begin');
    await writer.query("insert into app.gadgets values (1, 'x')");
    const pid = (await reindexer.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]
      ?.pid;
    const reindex = reindexer.query('reindex index concurrently app.gadgets_name_idx').then(
      () => 'finished',
      (error: unknown) => (error as Error).message,
    );
    try {
      await until(
        async () => {
          const rows = await query<{ waiting: boolean }>(
            db.owner,
            "select exists (select from pg_stat_activity where pid = $1 and wait_event_type = 'Lock') as waiting",
            [pid],
          );
          return rows[0]?.waiting === true;
        },
        { timeoutMs: 30_000, what: 'the reindex waiting for writers' },
      );
      await query(db.owner, 'select pg_cancel_backend($1)', [pid]);
      expect(await reindex).toMatch(/canceling statement/);
    } finally {
      await writer.query('rollback');
      await writer.end();
      await reindexer.end();
    }
    expect(await indexValid(db.owner, 'app.gadgets_name_idx_ccnew')).toBe(false);

    for (const command of ['up', 'down', 'status']) {
      const result = await migrate(['migrate', command], { url: db.owner });
      expect(result.code, `${command}\n${describeFailure(result)}`).toBe(4);
      expect(result.stderr).toContain('app.gadgets_name_idx_ccnew on app.gadgets');
    }
  });

  it('leave a marked down that breaks an index recorded, and status exits 4', async () => {
    const db = await dbs.fresh('base');
    const breaking = `${NO_TRANSACTION_MARKER}\n${migration(
      'drop index concurrently if exists app.widgets_name_key;',
      'create unique index concurrently if not exists widgets_name_key on app.widgets (name);',
    )}`;
    const dir = fixtureMigrations({ [TABLE]: table, [UNIQUE]: breaking });
    const up = await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir });
    expect(up.code, describeFailure(up)).toBe(0);
    await query(db.owner, "insert into app.widgets values (1, 'same'), (2, 'same')");

    const down = await migrate(['migrate', 'down'], { url: db.owner, migrationsDir: dir });
    expect(down.code, describeFailure(down)).toBe(1);
    expect(await indexValid(db.owner, 'app.widgets_name_key')).toBe(false);
    expect(await recorded(db, UNIQUE)).toEqual({ record: true, checksum: true });

    const status = await migrate(['migrate', 'status'], { url: db.owner, migrationsDir: dir });
    expect(status.code, describeFailure(status)).toBe(4);
    expect(status.stderr).toContain('app.widgets_name_key on app.widgets');
  });

  // Drefyn owns schema app through migrations; other schemas are not its business.
  it('ignore an invalid index outside app', async () => {
    const db = await dbs.fresh('base');
    await superuser(
      `create table public.outside (name text);
insert into public.outside values ('same'), ('same');`,
      db.name,
    );
    await superuser(
      'create unique index concurrently outside_name_key on public.outside (name);',
      db.name,
    ).catch(() => undefined);
    const valid = await superuser(
      "select indisvalid from pg_index where indexrelid = 'public.outside_name_key'::regclass;",
      db.name,
    );
    expect(valid.trim()).toBe('f');
    const up = await migrate(['migrate', 'up'], { url: db.owner });
    expect(up.code, describeFailure(up)).toBe(0);
  });
});
