import { expect, it } from 'vitest';
import { describeFailure, migrate, shippedMigrations } from './support/cli.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { superuser } from './support/stack.ts';

const dbs = databases();

const BEFORE = '((plan_tier = app.install_tier()) AND (read_only_since IS NULL))';
const AFTER =
  "((plan_tier = app.install_tier()) AND (read_only_since IS NULL) AND (sso_enforcement = 'off'::text) AND (sso_enforcement_since IS NULL))";

// Steps back to just before this migration, however many have landed after it.
function stepsBack(): number {
  const shipped = shippedMigrations();
  const at = shipped.findIndex((file) => file.endsWith('_organization_insert_sso.sql'));
  expect(at).toBeGreaterThanOrEqual(0);
  return shipped.length - at;
}

const step = async (db: TestDatabase, args: readonly string[]) => {
  const result = await migrate(args, { url: db.owner });
  expect(result.code, describeFailure(result)).toBe(0);
};

// The policy text and whether it is still restrictive, as the catalog holds them. An empty
// search path makes the deparse schema qualify app.install_tier(), as the catalog check sees it.
const guard = async (db: TestDatabase) =>
  (
    await superuser(
      `set search_path = '';
       select permissive || ' ' || cmd || ' ' || with_check from pg_policies
        where schemaname = 'app' and tablename = 'organizations'
          and policyname = 'organization_insert_tier';`,
      db.name,
    )
  ).trim();

describeWithStack('the organization insert SSO migration', () => {
  it('puts the tier only guard back on the way down and the enforcement terms on the way up', async () => {
    const db = await dbs.fresh('migrated');
    expect(await guard(db)).toBe(`RESTRICTIVE INSERT ${AFTER}`);
    await step(db, ['migrate', 'down', String(stepsBack())]);
    expect(await guard(db)).toBe(`RESTRICTIVE INSERT ${BEFORE}`);
    await step(db, ['migrate', 'up']);
    expect(await guard(db)).toBe(`RESTRICTIVE INSERT ${AFTER}`);
  });
});
