import { expect, it } from 'vitest';
import { describeFailure, migrate, shippedMigrations } from './support/cli.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { superuser } from './support/stack.ts';

const dbs = databases();

const TABLES = "('publish_approvals', 'publish_log', 'publish_workflows')";

// What the application role may do on each new table.
const appGrants = (db: TestDatabase) =>
  superuser(
    `select coalesce(string_agg(table_name || ' ' || privilege_type, ',' order by table_name,
       privilege_type), '')
     from information_schema.role_table_grants
     where grantee = 'drefyn_app' and table_schema = 'app' and table_name in ${TABLES};`,
    db.name,
  ).then((text) => text.trim());

const readerGrants = (db: TestDatabase) =>
  superuser(
    `select count(*) from information_schema.role_table_grants
     where grantee = 'drefyn_public_reader' and table_schema = 'app'
       and table_name in ${TABLES};`,
    db.name,
  ).then((text) => text.trim());

const GRANTS = [
  'publish_approvals INSERT',
  'publish_approvals SELECT',
  'publish_log INSERT',
  'publish_log SELECT',
  'publish_workflows DELETE',
  'publish_workflows INSERT',
  'publish_workflows SELECT',
  'publish_workflows UPDATE',
].join(',');

const step = async (db: TestDatabase, args: readonly string[]) => {
  const result = await migrate(args, { url: db.owner });
  expect(result.code, describeFailure(result)).toBe(0);
};

function stepsBack(): number {
  const shipped = shippedMigrations();
  const at = shipped.findIndex((file) => file.endsWith('_publish_gate.sql'));
  expect(at).toBeGreaterThanOrEqual(0);
  return shipped.length - at;
}

describeWithStack('the publish gate migration', () => {
  it('leaves both logs append only for the app role and hides all three from the reader', async () => {
    const db = await dbs.fresh('migrated');
    expect(await appGrants(db)).toBe(GRANTS);
    expect(await readerGrants(db)).toBe('0');
    const forced = await superuser(
      `select string_agg(relname || ' ' || relforcerowsecurity::text, ',' order by relname)
       from pg_class where relnamespace = 'app'::regnamespace and relname in ${TABLES};`,
      db.name,
    );
    expect(forced.trim()).toBe('publish_approvals true,publish_log true,publish_workflows true');
  });

  it('keeps one publish per key in a project', async () => {
    const db = await dbs.fresh('migrated');
    const keys = await superuser(
      `select pg_get_constraintdef(oid) from pg_constraint
       where conname = 'publish_log_idempotency_key';`,
      db.name,
    );
    expect(keys.trim()).toBe('UNIQUE (organization_id, project_id, idempotency_key)');
  });

  it('reverts cleanly and applies again', async () => {
    const db = await dbs.fresh('migrated');
    await step(db, ['migrate', 'down', String(stepsBack())]);
    const left = await superuser(
      `select count(*) from pg_tables where schemaname = 'app' and tablename in ${TABLES};`,
      db.name,
    );
    expect(left.trim()).toBe('0');
    await step(db, ['migrate', 'up']);
    expect(await appGrants(db)).toBe(GRANTS);
  });
});
