import { expect, it } from 'vitest';
import { describeFailure, migrate } from './support/cli.ts';
import { databases } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { migrateLockRows, migrationState } from './support/sql.ts';
import { schemaDump, superuser } from './support/stack.ts';

const dbs = databases();

const UPGRADE_COMPOSE = 'bash scripts/selfhost.sh upgrade';
const UPGRADE_FILE = 'deploy/postgres/upgrade/0001-auth-role.sql';

// Roles are cluster wide, so the missing role case lives in serial/. CONNECT is per database,
// so this file can take it away from its own clone while other files run.
describeWithStack('prerequisite check for drefyn_auth', () => {
  it.each([['up'], ['status']])(
    'exits 4 on %s when drefyn_auth may not connect, applies nothing and takes no lock',
    async (command) => {
      const db = await dbs.fresh('base');
      await superuser(`revoke connect on database ${db.name} from drefyn_auth;`);
      const dump = await schemaDump(db.name);

      const result = await migrate(['migrate', command], { url: db.owner });
      expect(result.code, describeFailure(result)).toBe(4);
      expect(result.stderr).toContain('drefyn_auth');
      expect(result.stderr).toContain('CONNECT');
      expect(result.stderr).toContain(UPGRADE_COMPOSE);
      expect(result.stderr).toContain(UPGRADE_FILE);
      expect(await migrationState(db.owner)).toBeNull();
      expect(await schemaDump(db.name)).toBe(dump);
      expect(await migrateLockRows(db.owner)).toEqual([]);
    },
  );

  it('passes on a database the bootstrap made', async () => {
    const db = await dbs.fresh('base');
    const result = await migrate(['migrate', 'up'], { url: db.owner });
    expect(result.code, describeFailure(result)).toBe(0);
  });
});
