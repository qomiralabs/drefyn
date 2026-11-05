import { expect, it } from 'vitest';
import { describeFailure, migrate, shippedMigrations } from './support/cli.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { superuser } from './support/stack.ts';

const dbs = databases();

const scalar = async (sql: string, db: TestDatabase) => (await superuser(sql, db.name)).trim();

function stepsBack(name: string): number {
  const shipped = shippedMigrations();
  const at = shipped.findIndex((file) => file.endsWith(name));
  expect(at).toBeGreaterThanOrEqual(0);
  return shipped.length - at;
}

const move = async (db: TestDatabase, argv: string[]) => {
  const result = await migrate(argv, { url: db.owner });
  expect(result.code, describeFailure(result)).toBe(0);
};

const check = (db: TestDatabase) =>
  scalar(
    `set search_path = pg_catalog;
     select pg_get_expr(polwithcheck, polrelid) from pg_policy
      where polname = 'api_key_update_unrevoked' and polrelid = 'app.api_keys'::regclass;`,
    db,
  );

const organizationGrant = (db: TestDatabase) =>
  scalar(
    `select has_column_privilege('drefyn_auth', 'app.api_keys', 'organization_id', 'select');`,
    db,
  );

describeWithStack('the expiry job migrations', () => {
  it('create the job row, one per job, readable only by the auth role', async () => {
    const db = await dbs.fresh('migrated');
    expect(
      await scalar(
        `select name, last_run_at is null, next_run_at <= now() from app.scheduled_jobs;`,
        db,
      ),
    ).toBe('auth_expiry|t|t');
    expect(
      await scalar(
        `select has_table_privilege('drefyn_auth', 'app.scheduled_jobs', 'select'),
                has_table_privilege('drefyn_auth', 'app.scheduled_jobs', 'update'),
                has_table_privilege('drefyn_auth', 'app.scheduled_jobs', 'insert'),
                has_table_privilege('drefyn_auth', 'app.scheduled_jobs', 'delete'),
                has_table_privilege('drefyn_app', 'app.scheduled_jobs', 'select');`,
        db,
      ),
    ).toBe('t|t|f|f|f');
  });

  it('remove the job table on the way down and bring it back on the way up', async () => {
    const db = await dbs.fresh('migrated');
    await move(db, ['migrate', 'down', String(stepsBack('_scheduled_jobs.sql'))]);
    expect(await scalar(`select to_regclass('app.scheduled_jobs') is null;`, db)).toBe('t');
    await move(db, ['migrate', 'up']);
    expect(await scalar(`select count(*) from app.scheduled_jobs;`, db)).toBe('1');
  });

  it('tie the revoke to the transaction time, and undo that on the way down', async () => {
    const db = await dbs.fresh('migrated');
    expect(await check(db)).toBe('((revoked_at IS NULL) OR (revoked_at = now()))');
    expect(await organizationGrant(db)).toBe('t');
    await move(db, ['migrate', 'down', String(stepsBack('_api_key_revoke_time.sql'))]);
    expect(await check(db)).toBe('true');
    expect(await organizationGrant(db)).toBe('f');
    await move(db, ['migrate', 'up']);
    expect(await check(db)).toBe('((revoked_at IS NULL) OR (revoked_at = now()))');
  });
});
