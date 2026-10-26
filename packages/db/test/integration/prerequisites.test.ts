import { expect, it } from 'vitest';
import { describeFailure, fixtureMigrations, migrate, migration } from './support/cli.ts';
import { databases } from './support/databases.ts';
import {
  backendPid,
  holdMigrateLock,
  migrateLockRows,
  migrationState,
  query,
} from './support/sql.ts';
import { describeWithStack } from './support/presence.ts';
import { schemaDump, superuser } from './support/stack.ts';

const dbs = databases();

const COMPOSE_UPDATE =
  "docker compose -f deploy/compose.yaml exec -T postgres psql --no-psqlrc -U postgres -d drefyn -c 'alter extension vector update'";
const MANAGED_UPDATE = "alter extension vector update to '<version>'";

// Each case is prepared by the superuser on its own throwaway database.
const cases = [
  {
    what: 'vector is not installed',
    sabotage: 'drop extension vector;',
    names: [/vector/, /not installed/i, /create extension vector schema extensions/],
  },
  {
    what: 'vector is in schema public',
    sabotage: 'alter extension vector set schema public;',
    names: [/public/, /alter extension vector set schema extensions/],
  },
  {
    what: 'vector is at 0.8.1',
    sabotage: "update pg_extension set extversion = '0.8.1' where extname = 'vector';",
    names: [/0\.8\.1/, /0\.8\.2/, COMPOSE_UPDATE, MANAGED_UPDATE],
  },
] as const;

function expectNames(stderr: string, names: readonly (RegExp | string)[]) {
  for (const name of names) {
    if (typeof name === 'string') expect(stderr).toContain(name);
    else expect(stderr).toMatch(name);
  }
}

describeWithStack('prerequisite check', () => {
  it.each(cases)(
    'exits 4 when $what, applies nothing and takes no lock',
    async ({ sabotage, names }) => {
      const db = await dbs.fresh('base');
      await superuser(sabotage, db.name);
      const dump = await schemaDump(db.name);

      const result = await migrate(['migrate', 'up'], { url: db.owner });
      expect(result.code, describeFailure(result)).toBe(4);
      expectNames(result.stderr, names);
      expect(await migrationState(db.owner)).toBeNull();
      expect(await schemaDump(db.name)).toBe(dump);
      expect(await migrateLockRows(db.owner)).toEqual([]);
    },
  );

  // Holding the lock makes the order visible: a run that tried the lock first would exit 2.
  it.each(cases)('checks before the lock when $what', async ({ sabotage, names }) => {
    const db = await dbs.fresh('base');
    await superuser(sabotage, db.name);
    const holder = await holdMigrateLock(db.owner);
    try {
      const result = await migrate(['migrate', 'up'], { url: db.owner });
      expect(result.code, describeFailure(result)).toBe(4);
      expectNames(result.stderr, names);
      const rows = await migrateLockRows(db.owner);
      expect(rows.map((r) => r.pid)).toEqual([await backendPid(holder)]);
    } finally {
      await holder.end();
    }
  });

  it('exits 4 on a migrated database and leaves its records as they were', async () => {
    const db = await dbs.fresh('migrated');
    const state = await migrationState(db.owner);
    const dir = fixtureMigrations({
      '9000000000001_widgets.sql': migration(
        'create table app.widgets (id int);',
        'drop table app.widgets;',
      ),
    });
    await superuser(
      "update pg_extension set extversion = '0.8.1' where extname = 'vector';",
      db.name,
    );
    const result = await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir });
    expect(result.code, describeFailure(result)).toBe(4);
    expect(await migrationState(db.owner)).toEqual(state);
    expect(await query(db.owner, "select to_regclass('app.widgets') as t")).toEqual([{ t: null }]);
  });

  it('passes on the compose image, vector 0.8.7 in extensions', async () => {
    const db = await dbs.fresh('base');
    expect(
      await query(
        db.owner,
        `select extversion, extnamespace::regnamespace::text as schema from pg_extension where extname = 'vector'`,
      ),
    ).toEqual([{ extversion: '0.8.7', schema: 'extensions' }]);
    const result = await migrate(['migrate', 'up'], { url: db.owner });
    expect(result.code, describeFailure(result)).toBe(0);
  });

  it.each(['0.8.2', '0.8.10', '0.10.0'])(
    'passes with extversion %s read from the server',
    async (version) => {
      const db = await dbs.fresh('base');
      await superuser(
        `update pg_extension set extversion = '${version}' where extname = 'vector';`,
        db.name,
      );
      const result = await migrate(['migrate', 'up'], { url: db.owner });
      expect(result.code, describeFailure(result)).toBe(0);
    },
  );
});

// Down steps can recreate vector columns, so every command checks first; status exits 4 too,
// so a health probe sees the problem. Neither may touch the migrate lock.
describeWithStack('prerequisite check on down and status', () => {
  // Cascade, so the case holds once a migration has a vector column.
  const DROP_VECTOR = 'drop extension vector cascade;';
  const MISSING = [/vector/, /not installed/i, /create extension vector schema extensions/];

  async function migratedWithoutVector() {
    const db = await dbs.fresh('migrated');
    const dir = fixtureMigrations({
      '9000000000001_widgets.sql': migration(
        'create table app.widgets (id int);',
        'drop table app.widgets;',
      ),
    });
    const up = await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir });
    expect(up.code, describeFailure(up)).toBe(0);
    await superuser(DROP_VECTOR, db.name);
    return { db, dir };
  }

  it.each([
    ['down', ['migrate', 'down']],
    ['status', ['migrate', 'status']],
  ] as const)('%s exits 4 with vector dropped and changes nothing', async (_, args) => {
    const { db, dir } = await migratedWithoutVector();
    const state = await migrationState(db.owner);
    const dump = await schemaDump(db.name);
    // The oid, not the printed name: the search_path drops the schema from regclass text.
    const widgets = () =>
      query<{ oid: string | null }>(db.owner, "select to_regclass('app.widgets')::oid as oid");
    const before = await widgets();
    expect(before[0]?.oid).not.toBeNull();

    const result = await migrate(args, { url: db.owner, migrationsDir: dir });
    expect(result.code, describeFailure(result)).toBe(4);
    expectNames(result.stderr, MISSING);
    expect(await migrationState(db.owner)).toEqual(state);
    expect(await schemaDump(db.name)).toBe(dump);
    expect(await widgets()).toEqual(before);
    expect(await migrateLockRows(db.owner)).toEqual([]);
  });

  // With the lock held elsewhere, a command that tried the lock first would exit 2.
  it.each([
    ['down', ['migrate', 'down']],
    ['status', ['migrate', 'status']],
  ] as const)('%s checks before the lock and never takes it', async (_, args) => {
    const { db, dir } = await migratedWithoutVector();
    const holder = await holdMigrateLock(db.owner);
    try {
      const result = await migrate(args, { url: db.owner, migrationsDir: dir });
      expect(result.code, describeFailure(result)).toBe(4);
      expectNames(result.stderr, MISSING);
      const rows = await migrateLockRows(db.owner);
      expect(rows.map((r) => r.pid)).toEqual([await backendPid(holder)]);
    } finally {
      await holder.end();
    }
  });

  it('status exits 4 on a database it never migrated and creates nothing', async () => {
    const db = await dbs.fresh('base');
    await superuser(DROP_VECTOR, db.name);
    const dump = await schemaDump(db.name);
    const result = await migrate(['migrate', 'status'], { url: db.owner });
    expect(result.code, describeFailure(result)).toBe(4);
    expectNames(result.stderr, MISSING);
    expect(await migrationState(db.owner)).toBeNull();
    expect(await schemaDump(db.name)).toBe(dump);
  });

  // A diagnostic must be safe to run while a real migration holds the lock.
  it('status succeeds while another session holds the lock', async () => {
    const db = await dbs.fresh('migrated');
    const holder = await holdMigrateLock(db.owner);
    try {
      const result = await migrate(['migrate', 'status'], { url: db.owner });
      expect(result.code, describeFailure(result)).toBe(0);
      const rows = await migrateLockRows(db.owner);
      expect(rows.map((r) => r.pid)).toEqual([await backendPid(holder)]);
    } finally {
      await holder.end();
    }
  });
});
