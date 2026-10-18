import { describe, expect, it } from 'vitest';
import { describeFailure, fixtureMigrations, migration } from './support/cli.ts';
import { databases } from './support/databases.ts';
import { run } from './support/process.ts';
import { packageRoot } from './support/stack.ts';

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
