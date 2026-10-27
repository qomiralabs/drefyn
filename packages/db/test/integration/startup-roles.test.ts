import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase, createPublishedDatabase } from '../../src/database.ts';
import { DbError } from '../../src/errors.ts';
import { closeDatabase } from '../../src/index.ts';
import { errorText, rejected } from '../support.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { until } from './support/process.ts';
import { stack, superuser } from './support/stack.ts';
import { appConfig, backendsOf, fixtureTemplate, readerConfig } from './support/tenancy.ts';

const dbs = databases();
const fixture = fixtureTemplate(dbs);

// Roles are cluster wide, so each run makes its own names and drops them after.
const ROLE_PREFIX = 'drefyn_test_role_';
const suffix = randomBytes(4).toString('hex');
const SUPERUSER = `${ROLE_PREFIX}su_${suffix}`;
const BYPASS = `${ROLE_PREFIX}bypass_${suffix}`;
const PASSWORD = randomBytes(18).toString('hex');

let db: TestDatabase;

function urlAs(role: string): string {
  return `postgres://${role}:${PASSWORD}@127.0.0.1:${stack().port}/${db.name}`;
}

async function unsafe(promise: Promise<unknown>): Promise<DbError> {
  const error = await rejected(promise);
  expect(error).toBeInstanceOf(DbError);
  expect((error as DbError).code).toBe('DB_ROLE_UNSAFE');
  expect(errorText(error)).not.toContain(PASSWORD);
  return error as DbError;
}

async function noBackendsLeft(role: string): Promise<void> {
  await until(async () => (await backendsOf(role, db.name)).length === 0, {
    timeoutMs: 5000,
    what: `${role} backends to close`,
  });
}

describeWithStack('startup role check', () => {
  beforeAll(async () => {
    db = await fixture();
    // Leftovers from a run that died before its afterAll.
    await superuser(`
      do $$
      declare r name;
      begin
        for r in select rolname from pg_roles where rolname like '${ROLE_PREFIX}%' loop
          execute format('drop role %I', r);
        end loop;
      end $$;
    `);
    await superuser(`
      create role ${SUPERUSER} login superuser password '${PASSWORD}';
      create role ${BYPASS} login nosuperuser bypassrls password '${PASSWORD}';
      grant connect on database ${db.name} to ${BYPASS};
    `);
  });

  afterAll(async () => {
    await superuser(
      `
      revoke all on database ${db.name} from ${BYPASS};
      drop role if exists ${SUPERUSER};
      drop owned by ${BYPASS};
      drop role if exists ${BYPASS};
    `,
      db.name,
    ).catch(() => undefined);
    await superuser(`drop role if exists ${SUPERUSER}; drop role if exists ${BYPASS};`);
  });

  // Closing right after start must also end the connection the role check used, even
  // though no transaction ever ran on the pool.
  it('starts the app pool as drefyn_app and the reader pool as the reader', async () => {
    await closeDatabase(await createDatabase(appConfig(db.app)));
    await closeDatabase(await createPublishedDatabase(readerConfig(db.reader)));
    await noBackendsLeft('drefyn_app');
    await noBackendsLeft('drefyn_public_reader');
  });

  it('refuses a superuser', async () => {
    const error = await unsafe(createDatabase(appConfig(urlAs(SUPERUSER))));
    expect(error.message).toMatch(/superuser/i);
    await noBackendsLeft(SUPERUSER);
  });

  it('refuses a superuser on the reader pool', async () => {
    const error = await unsafe(createPublishedDatabase(readerConfig(urlAs(SUPERUSER))));
    expect(error.message).toMatch(/superuser/i);
  });

  it('refuses a BYPASSRLS role', async () => {
    const error = await unsafe(createDatabase(appConfig(urlAs(BYPASS))));
    expect(error.message).toMatch(/bypassrls/i);
    await noBackendsLeft(BYPASS);
  });

  it('refuses the owner of the app tables', async () => {
    const error = await unsafe(createDatabase(appConfig(db.owner)));
    expect(error.message).toMatch(/owns/i);
    expect(error.message).toContain('app.fixture_notes');
    await noBackendsLeft('drefyn_owner');
  });

  it('refuses the app pool on the reader role', async () => {
    const error = await unsafe(createDatabase(appConfig(db.reader)));
    expect(error.message).toContain('drefyn_public_reader');
    expect(error.message).toContain('drefyn_app');
    await noBackendsLeft('drefyn_public_reader');
  });

  it('refuses the reader pool on the app role', async () => {
    const error = await unsafe(createPublishedDatabase(readerConfig(db.app)));
    expect(error.message).toContain('drefyn_public_reader');
    expect(error.message).toContain('drefyn_app');
  });

  it('refuses the reader pool on the owner', async () => {
    await unsafe(createPublishedDatabase(readerConfig(db.owner)));
  });

  it('fails a wrong password as bad config, without the password', async () => {
    const url = db.app.replace(/:[^:@/]+@/, ':not-the-password-at-all@');
    const error = await rejected(createDatabase(appConfig(url)));
    expect((error as DbError).code).toBe('DB_CONFIG_INVALID');
    expect(errorText(error)).not.toContain('not-the-password-at-all');
    expect(errorText(error)).not.toContain(stack().passwords.app);
  });
});
