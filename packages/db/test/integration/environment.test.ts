import { expect, it } from 'vitest';
import { describeFailure, fixtureMigrations, migrate, migration } from './support/cli.ts';
import { databases } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { query } from './support/sql.ts';

const dbs = databases();

// PGOPTIONS would otherwise reach the server as startup options for the migrate role, the
// same session settings a URL query string is refused for.
describeWithStack('the PG* environment', () => {
  it('cannot set session settings or the password for drefyn migrate', async () => {
    const db = await dbs.fresh('base');
    const dir = fixtureMigrations({
      '9000000000001_probe.sql': migration(
        `create table app.env_probe as
           select current_setting('search_path') as search_path,
                  current_setting('lock_timeout') as lock_timeout,
                  current_setting('application_name') as application_name;`,
        'drop table app.env_probe;',
      ),
    });
    const result = await migrate(['migrate', 'up'], {
      url: db.owner,
      migrationsDir: dir,
      env: {
        PGOPTIONS: '-c search_path=public -c lock_timeout=0 -c application_name=hostile',
        PGPASSWORD: 'not-the-owner-password-1414',
        PGAPPNAME: 'hostile',
      },
    });
    expect(result.code, describeFailure(result)).toBe(0);
    expect(await query(db.owner, 'select * from app.env_probe')).toEqual([
      { search_path: 'app, extensions', lock_timeout: '2s', application_name: 'drefyn-migrate' },
    ]);
  });
});
