import { expect, it } from 'vitest';
import { describeFailure, migrate, shippedMigrations } from './support/cli.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { superuser } from './support/stack.ts';

const dbs = databases();

const column = async (db: TestDatabase) =>
  (
    await superuser(
      `select coalesce(string_agg(data_type || ' ' || is_nullable, ','), '')
       from information_schema.columns
       where table_schema = 'app' and table_name = 'chunks'
         and column_name = 'render_policy_version';`,
      db.name,
    )
  ).trim();

const check = async (db: TestDatabase) =>
  (
    await superuser(
      `select coalesce(string_agg(conname, ','), '') from pg_constraint
       where conname = 'chunks_render_policy_version_check';`,
      db.name,
    )
  ).trim();

const step = async (db: TestDatabase, args: readonly string[]) => {
  const result = await migrate(args, { url: db.owner });
  expect(result.code, describeFailure(result)).toBe(0);
};

// However many have landed after it.
function stepsBack(): number {
  const shipped = shippedMigrations();
  const at = shipped.findIndex((file) => file.endsWith('_chunks_render_policy_version.sql'));
  expect(at).toBeGreaterThanOrEqual(0);
  return shipped.length - at;
}

describeWithStack('the chunk render policy migration', () => {
  it('adds a nullable integer that refuses a version below one, and down takes it away', async () => {
    const db = await dbs.fresh('migrated');
    expect(await column(db)).toBe('integer YES');
    expect(await check(db)).toBe('chunks_render_policy_version_check');

    await step(db, ['migrate', 'down', String(stepsBack())]);
    expect(await column(db)).toBe('');
    expect(await check(db)).toBe('');

    await step(db, ['migrate', 'up']);
    expect(await column(db)).toBe('integer YES');
  });
});
