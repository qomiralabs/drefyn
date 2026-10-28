import { afterEach, expect, it } from 'vitest';
import { describeFailure, migrate } from '../support/cli.ts';
import { databases } from '../support/databases.ts';
import { describeWithStack } from '../support/presence.ts';
import { migrateLockRows, migrationState } from '../support/sql.ts';
import { superuser } from '../support/stack.ts';

// Renaming the role is cluster wide, so this runs alone and always puts the name back. A
// rename keeps the password and grants, so nothing else needs restoring.
const dbs = databases();
const ASIDE = 'drefyn_auth_test_aside';

async function restore(): Promise<void> {
  await superuser(`
select exists (select from pg_roles where rolname = '${ASIDE}') as aside \\gset
\\if :aside
alter role ${ASIDE} rename to drefyn_auth;
\\endif
`);
}

describeWithStack('prerequisite check when drefyn_auth is missing', () => {
  afterEach(restore);

  it.each([['up'], ['down'], ['status']])(
    'exits 4 on %s naming drefyn_auth and the upgrade command, before the lock',
    async (command) => {
      const db = await dbs.fresh('base');
      await superuser(`alter role drefyn_auth rename to ${ASIDE};`);

      const result = await migrate(['migrate', command], { url: db.owner });
      expect(result.code, describeFailure(result)).toBe(4);
      expect(result.stderr).toContain('drefyn_auth');
      expect(result.stderr).toMatch(/does not exist/);
      expect(result.stderr).toContain('bash scripts/selfhost.sh upgrade');
      expect(result.stderr).toContain(
        'psql --no-psqlrc --dbname drefyn --file deploy/postgres/upgrade/0001-auth-role.sql',
      );
      expect(await migrationState(db.owner)).toBeNull();
      expect(await migrateLockRows(db.owner)).toEqual([]);
    },
  );
});
