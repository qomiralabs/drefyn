import { afterEach, beforeAll, expect, it } from 'vitest';
import { ALLOW_LISTS } from '../../../src/allow-lists.ts';
import { DbError } from '../../../src/errors.ts';
import {
  closeDatabase,
  createAuthDatabase,
  createDatabase,
  createPublishedDatabase,
} from '../../../src/index.ts';
import { rejected } from '../../support.ts';
import { BOOTSTRAPPED, databases, type TestDatabase } from '../support/databases.ts';
import { describeWithStack } from '../support/presence.ts';
import { query } from '../support/sql.ts';
import { superuser } from '../support/stack.ts';
import {
  appConfig,
  authConfig,
  authUrl,
  catalogProblems,
  readerConfig,
} from '../support/tenancy.ts';

// Role settings and attributes are cluster wide, so this file runs on its own, after every
// other integration file, and puts each change back before the next test.
const dbs = databases();

let db: TestDatabase;

const reset = () => `
alter role drefyn_app in database ${db.name} reset all;
alter role drefyn_app reset all;
alter role drefyn_public_reader reset all;
alter role drefyn_auth reset all;
alter role drefyn_app in database ${BOOTSTRAPPED} reset all;
alter role drefyn_public_reader in database ${BOOTSTRAPPED} reset all;
alter role drefyn_app nosuperuser nobypassrls;
alter role drefyn_public_reader nosuperuser nobypassrls;
revoke drefyn_owner from drefyn_app;
alter role all reset all;
`;

async function settingsRows(): Promise<number> {
  const out = await superuser(
    `select count(*) from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
      where r.rolname in ('drefyn_app', 'drefyn_public_reader', 'drefyn_auth');`,
  );
  return Number(out.trim());
}

async function unsafe(promise: Promise<unknown>): Promise<DbError> {
  const error = await rejected(promise);
  expect(error).toBeInstanceOf(DbError);
  expect((error as DbError).code).toBe('DB_ROLE_UNSAFE');
  return error as DbError;
}

async function roleSettingProblem(role: string) {
  const problems = await catalogProblems(db.owner, ALLOW_LISTS);
  const hit = problems.find((p) => p.rule === 'role_setting' && p.object === role);
  expect(hit, problems.map((p) => `${p.rule} ${p.object}: ${p.message}`).join('\n')).toBeDefined();
  return hit?.message ?? '';
}

describeWithStack('persisted role settings', () => {
  beforeAll(async () => {
    db = await dbs.fresh('migrated');
    await superuser(reset());
  });

  afterEach(async () => {
    await superuser(reset());
    expect(await settingsRows()).toBe(0);
  });

  it('pass the catalog check and startup when there are none', async () => {
    expect(await settingsRows()).toBe(0);
    const problems = await catalogProblems(db.owner, ALLOW_LISTS);
    expect(problems.filter((p) => p.rule === 'role_setting')).toEqual([]);
    await closeDatabase(await createDatabase(appConfig(db.app)));
    await closeDatabase(await createPublishedDatabase(readerConfig(db.reader)));
  });

  it('fail after drefyn_app sets its own search_path', async () => {
    await query(db.app, 'alter role drefyn_app set search_path = public');
    const message = await roleSettingProblem('drefyn_app');
    expect(message).toContain('search_path');
    const error = await unsafe(createDatabase(appConfig(db.app)));
    expect(error.message).toContain('search_path');
  });

  it('fail after the reader sets role on itself', async () => {
    await query(db.reader, 'alter role drefyn_public_reader set role = drefyn_public_reader');
    const message = await roleSettingProblem('drefyn_public_reader');
    expect(message).toMatch(/\brole\b/);
    const error = await unsafe(createPublishedDatabase(readerConfig(db.reader)));
    expect(error.message).toMatch(/\brole\b/);
  });

  it('fail after drefyn_auth gets a search_path of its own', async () => {
    await superuser('alter role drefyn_auth set search_path = public;');
    const message = await roleSettingProblem('drefyn_auth');
    expect(message).toContain('search_path');
    const error = await unsafe(createAuthDatabase(authConfig(authUrl(db))));
    expect(error.message).toContain('search_path');
  });

  it('fail after the superuser sets a per database setting for drefyn_app', async () => {
    await superuser(`alter role drefyn_app in database ${BOOTSTRAPPED} set statement_timeout = 0;`);
    const message = await roleSettingProblem('drefyn_app');
    expect(message).toContain('statement_timeout');
    expect(message).toContain(BOOTSTRAPPED);
    const error = await unsafe(createDatabase(appConfig(db.app)));
    expect(error.message).toContain('statement_timeout');
  });

  it('fail for a setting in the database the pool connects to', async () => {
    await superuser(`alter role drefyn_app in database ${db.name} set work_mem = '64MB';`);
    expect(await roleSettingProblem('drefyn_app')).toContain('work_mem');
    await unsafe(createDatabase(appConfig(db.app)));
  });
});

describeWithStack('role attributes changed after the bootstrap', () => {
  beforeAll(async () => {
    db = await dbs.fresh('migrated');
    await superuser(reset());
  });

  afterEach(async () => {
    await superuser(reset());
  });

  it('refuse drefyn_app once it is a superuser', async () => {
    await superuser('alter role drefyn_app superuser;');
    expect((await unsafe(createDatabase(appConfig(db.app)))).message).toMatch(/superuser/i);
  });

  it('refuse drefyn_app once it has BYPASSRLS', async () => {
    await superuser('alter role drefyn_app bypassrls;');
    expect((await unsafe(createDatabase(appConfig(db.app)))).message).toMatch(/bypassrls/i);
  });

  it('refuse the reader once it has BYPASSRLS', async () => {
    await superuser('alter role drefyn_public_reader bypassrls;');
    await unsafe(createPublishedDatabase(readerConfig(db.reader)));
  });

  // NOINHERIT keeps the owner's rights off by default, but SET ROLE still reaches them.
  it('refuse drefyn_app once it is a member of drefyn_owner', async () => {
    await superuser('grant drefyn_owner to drefyn_app;');
    expect((await unsafe(createDatabase(appConfig(db.app)))).message).toContain('drefyn_owner');
  });
});

// Database wide settings apply to every role that connects, the pools included.
describeWithStack('database wide settings', () => {
  const restore = () => `
alter database ${db.name} reset all;
alter database ${db.name} set search_path = app, extensions;
`;

  beforeAll(async () => {
    db = await dbs.fresh('migrated');
  });

  afterEach(async () => {
    await superuser(restore());
  });

  it('allow the bootstrap search_path and nothing else', async () => {
    const rows = await superuser(
      `select array_to_string(setconfig, '|') from pg_db_role_setting
        where setrole = 0 and setdatabase = (select oid from pg_database where datname = '${db.name}');`,
    );
    expect(rows.trim()).toBe('search_path=app, extensions');
    await closeDatabase(await createDatabase(appConfig(db.app)));
    await closeDatabase(await createPublishedDatabase(readerConfig(db.reader)));
  });

  it.each([
    [
      'a default organization',
      "drefyn.organization_id = '01a14984-4476-77ce-9335-00000000000a'",
      'drefyn.organization_id',
    ],
    [
      'a default project',
      "drefyn.project_id = '01a14984-4476-77ce-9335-0000000000a1'",
      'drefyn.project_id',
    ],
    ['another search_path', 'search_path = public', 'search_path'],
    ['any other setting', "work_mem = '64MB'", 'work_mem'],
  ])('refuse %s at startup for both pools', async (_label, setting, name) => {
    await superuser(`alter database ${db.name} set ${setting};`);
    const app = await unsafe(createDatabase(appConfig(db.app)));
    expect(app.message).toContain(name);
    const reader = await unsafe(createPublishedDatabase(readerConfig(db.reader)));
    expect(reader.message).toContain(name);
  });
});

// alter role all set ... is stored for no role and no database, and follows every
// connection in the cluster, the pools included.
describeWithStack('settings for all roles', () => {
  beforeAll(async () => {
    db = await dbs.fresh('migrated');
    await superuser(reset());
  });

  afterEach(async () => {
    await superuser(reset());
  });

  it('fail the catalog check and startup for both pools', async () => {
    await superuser("alter role all set work_mem = '64MB';");
    const problems = await catalogProblems(db.owner, ALLOW_LISTS);
    const hit = problems.find((p) => p.rule === 'role_setting' && p.object === 'all roles');
    expect(hit?.message).toContain('work_mem');
    expect((await unsafe(createDatabase(appConfig(db.app)))).message).toContain('work_mem');
    expect((await unsafe(createPublishedDatabase(readerConfig(db.reader)))).message).toContain(
      'work_mem',
    );
  });
});
