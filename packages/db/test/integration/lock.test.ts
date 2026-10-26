import { expect, it } from 'vitest';
import {
  describeFailure,
  fixtureMigrations,
  migrate,
  migration,
  startMigrate,
} from './support/cli.ts';
import { describeWithStack } from './support/presence.ts';
import { databases } from './support/databases.ts';
import { until } from './support/process.ts';
import {
  backendPid,
  holdMigrateLock,
  migrateLockRows,
  migrationState,
  query,
  session,
  tableExists,
} from './support/sql.ts';

const dbs = databases();
const HELD = /another run holds the (migration )?lock/i;
// A key of the test's own that the gate fixture waits on.
const GATE = 1414;

describeWithStack('advisory lock', () => {
  it('exits 2 and applies nothing while another session holds the lock', async () => {
    const db = await dbs.fresh('base');
    const holder = await holdMigrateLock(db.owner);
    try {
      const result = await migrate(['migrate', 'up'], { url: db.owner });
      expect(result.code, describeFailure(result)).toBe(2);
      expect(result.stderr).toMatch(HELD);
      expect(await migrationState(db.owner)).toBeNull();
    } finally {
      await holder.end();
    }
    const after = await migrate(['migrate', 'up'], { url: db.owner });
    expect(after.code, describeFailure(after)).toBe(0);
  });

  it('lets one of two concurrent runs finish and turns the other away with 2', async () => {
    const db = await dbs.fresh('base');
    // The first run stops inside its last migration, holding the migrate lock, until the
    // test opens the gate. lock_timeout 0 there so the wait outlasts the 2 s default.
    const dir = fixtureMigrations({
      '9000000000001_gate.sql': migration(
        `set local lock_timeout = 0;\nselect pg_advisory_xact_lock(${GATE});\ncreate table app.gate_passed (id int);`,
        'drop table app.gate_passed;',
      ),
    });
    const gate = await session(db.owner);
    await gate.query('select pg_advisory_lock($1)', [GATE]);
    const first = startMigrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir });
    try {
      await until(
        async () => {
          const rows = await query<{ waiting: boolean }>(
            db.owner,
            `select exists (select from pg_locks where locktype = 'advisory' and objid = $1 and not granted) as waiting`,
            [GATE],
          );
          return rows[0]?.waiting === true;
        },
        { timeoutMs: 30_000, watching: first, what: 'first run reaching the gate' },
      );
      const holders = (await migrateLockRows(db.owner)).filter((r) => r.granted);
      expect(holders).toHaveLength(1);
      expect(holders[0]?.pid).not.toBe(await backendPid(gate));

      const second = await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir });
      expect(second.code, describeFailure(second)).toBe(2);
      expect(second.stderr).toMatch(HELD);
    } finally {
      await gate.query('select pg_advisory_unlock($1)', [GATE]);
      await gate.end();
    }
    const done = await first.done;
    expect(done.code, describeFailure(done)).toBe(0);
    const state = await migrationState(db.owner);
    expect(state?.applied.filter((n) => n === '9000000000001_gate')).toHaveLength(1);
    expect(await tableExists(db.owner, 'app.gate_passed')).toBe(true);
  });

  it('releases the lock when it finishes', async () => {
    const db = await dbs.fresh('base');
    const result = await migrate(['migrate', 'up'], { url: db.owner });
    expect(result.code, describeFailure(result)).toBe(0);
    expect(await migrateLockRows(db.owner)).toEqual([]);
  });

  it('releases the lock when a migration fails', async () => {
    const db = await dbs.fresh('base');
    const dir = fixtureMigrations({
      '9000000000001_broken.sql': migration('select 1 / 0;', 'select 1;'),
    });
    const result = await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir });
    expect(result.code, describeFailure(result)).toBe(1);
    // It got as far as running the file, so it held the lock and let it go.
    expect(result.stderr).toMatch(/division by zero/);
    expect(result.stderr).toContain('9000000000001_broken');
    expect(await migrateLockRows(db.owner)).toEqual([]);
  });

  it('only locks its own database', async () => {
    const a = await dbs.fresh('base');
    const b = await dbs.fresh('base');
    const holder = await holdMigrateLock(a.owner);
    try {
      const result = await migrate(['migrate', 'up'], { url: b.owner });
      expect(result.code, describeFailure(result)).toBe(0);
    } finally {
      await holder.end();
    }
  });
});

describeWithStack('lock_timeout inside migrations', () => {
  it('is 2 s while a migration runs', async () => {
    const db = await dbs.fresh('base');
    const dir = fixtureMigrations({
      '9000000000001_probe.sql': migration(
        "create table app.lock_probe as select current_setting('lock_timeout') as value;",
        'drop table app.lock_probe;',
      ),
    });
    const result = await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir });
    expect(result.code, describeFailure(result)).toBe(0);
    expect(await query(db.owner, 'select value from app.lock_probe')).toEqual([{ value: '2s' }]);
  });

  it('gives up on a table another session holds, exits 1 and rolls the file back', async () => {
    const db = await dbs.fresh('base');
    await query(db.owner, 'create table app.contended (id int)');
    const dir = fixtureMigrations({
      '9000000000001_contended.sql': migration(
        'create table app.after_contended (id int);\nalter table app.contended add column note text;',
        'drop table app.after_contended;\nalter table app.contended drop column note;',
      ),
    });
    const holder = await session(db.owner);
    await holder.query('begin');
    await holder.query('lock table app.contended in access exclusive mode');
    const started = performance.now();
    let result;
    try {
      result = await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir });
    } finally {
      await holder.query('rollback');
      await holder.end();
    }
    const elapsed = performance.now() - started;
    expect(result.code, describeFailure(result)).toBe(1);
    expect(result.stderr).toMatch(/lock timeout/i);
    // It waited for the lock rather than failing for another reason, and did not hang.
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(elapsed).toBeLessThan(20_000);
    expect(await tableExists(db.owner, 'app.after_contended')).toBe(false);
    expect((await migrationState(db.owner))?.applied).not.toContain('9000000000001_contended');
  });
});
