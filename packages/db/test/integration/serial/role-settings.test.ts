import { afterEach, beforeAll, expect, it } from 'vitest';
import { ALLOW_LISTS } from '../../../src/allow-lists.ts';
import { DbError } from '../../../src/errors.ts';
import { closeDatabase, createDatabase, createPublishedDatabase } from '../../../src/index.ts';
import { rejected } from '../../support.ts';
import { BOOTSTRAPPED, databases, type TestDatabase } from '../support/databases.ts';
import { describeWithStack } from '../support/presence.ts';
import { query } from '../support/sql.ts';
import { superuser } from '../support/stack.ts';
import { appConfig, catalogProblems, readerConfig } from '../support/tenancy.ts';

// Role settings and attributes are cluster wide, so this file runs on its own, after every
// other integration file, and puts each change back before the next test.
const dbs = databases();

let db: TestDatabase;

const reset = () => `
alter role drefyn_app in database ${db.name} reset all;
alter role drefyn_app reset all;
alter role drefyn_public_reader reset all;
alter role drefyn_app in database ${BOOTSTRAPPED} reset all;
alter role drefyn_public_reader in database ${BOOTSTRAPPED} reset all;
alter role drefyn_app nosuperuser nobypassrls;
alter role drefyn_public_reader nosuperuser nobypassrls;
revoke drefyn_owner from drefyn_app;
`;

async function settingsRows(): Promise<number> {
  const out = await superuser(
    `select count(*) from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
      where r.rolname in ('drefyn_app', 'drefyn_public_reader');`,
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
