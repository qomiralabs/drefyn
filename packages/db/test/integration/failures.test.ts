import { describe, expect, it } from 'vitest';
import { describeFailure, fixtureMigrations, migrate, migration } from './support/cli.ts';
import { databases } from './support/databases.ts';
import { start } from './support/process.ts';
import { migrationState, tableExists } from './support/sql.ts';
import { packageRoot, stack, urlFor } from './support/stack.ts';
import { join } from 'node:path';

const dbs = databases();

describe('failures exit 1', () => {
  it('rolls back a file that fails halfway and records nothing for it', async () => {
    const db = await dbs.fresh('base');
    const dir = fixtureMigrations({
      '9000000000001_ok.sql': migration('create table app.ok (id int);', 'drop table app.ok;'),
      '9000000000002_half.sql': migration(
        'create table app.half (id int);\nselect 1 / 0;',
        'drop table app.half;',
      ),
    });
    const result = await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir });
    expect(result.code, describeFailure(result)).toBe(1);
    expect(result.stderr).toContain('9000000000002_half');
    expect(await tableExists(db.owner, 'app.half')).toBe(false);
    expect(await tableExists(db.owner, 'app.ok')).toBe(true);
    const applied = (await migrationState(db.owner))?.applied ?? [];
    expect(applied).toContain('9000000000001_ok');
    expect(applied).not.toContain('9000000000002_half');
  });

  // Every file is parsed before the first connection, so nothing runs, not even the
  // bookkeeping tables.
  it.each([
    [
      'a missing down section',
      '9000000000001_bad.sql',
      '-- Up Migration\ncreate table app.bad (id int);\n',
    ],
    ['a missing up section', '9000000000001_bad.sql', '-- Down Migration\ndrop table app.bad;\n'],
    ['a stray script', '9000000000001_bad.js', 'module.exports = {};\n'],
  ])('refuses %s before any SQL runs', async (_, name, text) => {
    const db = await dbs.fresh('base');
    const dir = fixtureMigrations({ [name]: text });
    const result = await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir });
    expect(result.code, describeFailure(result)).toBe(1);
    expect(result.stderr).toContain(name);
    expect(await migrationState(db.owner)).toBeNull();
  });

  it('exits 1 with DB_CONFIG_INVALID from the real process when the URL is missing', async () => {
    const result = await start(
      process.execPath,
      [join(packageRoot, 'src', 'cli.ts'), 'migrate', 'up'],
      {
        env: { PATH: process.env['PATH'] ?? '' },
      },
    ).done;
    expect(result.code, describeFailure(result)).toBe(1);
    expect(result.stderr).toContain('DB_CONFIG_INVALID');
    expect(result.stderr).toContain('DREFYN_MIGRATION_DATABASE_URL');
  });

  it('exits 1 on a wrong password and never prints either password', async () => {
    const db = await dbs.fresh('base');
    const wrong = 'not-the-owner-password-1414';
    const result = await migrate(['migrate', 'up'], { url: urlFor('owner', db.name, wrong) });
    expect(result.code, describeFailure(result)).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/password authentication failed for user "drefyn_owner"/);
    expect(output).not.toContain(wrong);
    expect(output).not.toContain(stack().passwords.owner);
  });

  it('exits 1 for a database that does not exist, without the password', async () => {
    const result = await migrate(['migrate', 'up'], {
      url: urlFor('owner', 'drefyn_test_absent_db'),
    });
    expect(result.code, describeFailure(result)).toBe(1);
    expect(result.stderr).toMatch(/database "drefyn_test_absent_db" does not exist/);
    expect(result.stdout + result.stderr).not.toContain(stack().passwords.owner);
  });
});
