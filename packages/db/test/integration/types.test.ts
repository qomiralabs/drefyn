import { describe, expect, it } from 'vitest';
import { describeFailure, fixtureMigrations, migration } from './support/cli.ts';
import { databases } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { run } from './support/process.ts';
import { migrationState } from './support/sql.ts';
import { packageRoot, schemaDump } from './support/stack.ts';

const dbs = databases();

function checkTypes(url: string, migrationsDir?: string) {
  return run(
    'pnpm',
    [
      'run',
      '--silent',
      'check:types',
      ...(migrationsDir === undefined ? [] : ['--migrations-dir', migrationsDir]),
    ],
    {
      cwd: packageRoot,
      env: { ...process.env, DREFYN_MIGRATION_DATABASE_URL: url, DREFYN_DATABASE_SSL: 'disable' },
    },
  );
}

describe('check:types', () => {
  it('passes when the committed types match the migrated schema', async () => {
    const db = await dbs.fresh('base');
    const result = await checkTypes(db.owner);
    expect(result.code, describeFailure(result)).toBe(0);
  });

  it('fails naming the table when a migration lands without regenerated types', async () => {
    const db = await dbs.fresh('base');
    const dir = fixtureMigrations({
      '9000000000001_widgets.sql': migration(
        'create table app.widgets (id uuid primary key default uuidv7(), name text not null);',
        'drop table app.widgets;',
      ),
    });
    const result = await checkTypes(db.owner, dir);
    expect(result.code, describeFailure(result)).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('widgets');
  });
});

// check:types migrates the database it is given, so it must refuse one that already has
// history: that may be a live database pointed at by mistake.
describeWithStack('check:types on a database that is not empty', () => {
  it('exits 1 saying so and applies nothing', async () => {
    const db = await dbs.fresh('migrated');
    const state = await migrationState(db.owner);
    const dump = await schemaDump(db.name);
    const dir = fixtureMigrations({
      '9000000000001_widgets.sql': migration(
        'create table app.widgets (id int);',
        'drop table app.widgets;',
      ),
    });

    const result = await checkTypes(db.owner, dir);
    expect(result.code, describeFailure(result)).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/not empty/i);
    expect(await migrationState(db.owner)).toEqual(state);
    expect(await schemaDump(db.name)).toBe(dump);
  });
});
