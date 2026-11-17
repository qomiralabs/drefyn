import { expect, it } from 'vitest';
import { ALLOW_LISTS } from '../../src/allow-lists.ts';
import { describeFailure, migrate, shippedMigrations } from './support/cli.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { seed, seedTenant, seedTenantsSql } from './support/published-chunks.ts';
import { superuser } from './support/stack.ts';
import { catalogProblems } from './support/tenancy.ts';

const dbs = databases();

const TABLES = ['site_access', 'visibility_log'];
const IN = `(${TABLES.map((t) => `'${t}'`).join(', ')})`;

const lines = (text: string) =>
  text
    .trim()
    .split('\n')
    .filter((line) => line !== '');

const grants = (db: TestDatabase) =>
  superuser(
    `select grantee || ' ' || table_name || ' ' || privilege_type
       from information_schema.role_table_grants
      where table_schema = 'app' and table_name in ${IN}
        and grantee in ('drefyn_public_reader', 'drefyn_protected_reader', 'drefyn_app')
      order by grantee, table_name, privilege_type;`,
    db.name,
  ).then(lines);

const step = async (db: TestDatabase, args: readonly string[]) => {
  const result = await migrate(args, { url: db.owner });
  expect(result.code, describeFailure(result)).toBe(0);
};

function stepsBack(): number {
  const shipped = shippedMigrations();
  const at = shipped.findIndex((file) => file.endsWith('_visibility_settings.sql'));
  expect(at).toBeGreaterThanOrEqual(0);
  return shipped.length - at;
}

// Runs a statement as the application role under one tenant, as the engine does. Answers the
// error text, or the output after the tenant line.
const asApp = (db: TestDatabase, org: string, project: string, text: string) =>
  superuser(
    `set role drefyn_app;
     select set_config('drefyn.organization_id', '${org}', false),
            set_config('drefyn.project_id', '${project}', false);
     ${text}`,
    db.name,
  ).then(
    (out) => lines(out).slice(1).join('\n'),
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

const A = seedTenant(62, 1);
const B = seedTenant(62, 2);

describeWithStack('the visibility settings migration', () => {
  it('forces RLS on both tables, keeps the log append only and gives the readers nothing', async () => {
    const db = await dbs.fresh('migrated');
    const forced = await superuser(
      `select relname || ' ' || relrowsecurity || ' ' || relforcerowsecurity from pg_class
        where relnamespace = 'app'::regnamespace and relname in ${IN} order by relname;`,
      db.name,
    );
    expect(lines(forced)).toEqual(TABLES.map((t) => `${t} true true`));
    expect(await grants(db)).toEqual([
      'drefyn_app site_access DELETE',
      'drefyn_app site_access INSERT',
      'drefyn_app site_access SELECT',
      'drefyn_app site_access UPDATE',
      'drefyn_app visibility_log INSERT',
      'drefyn_app visibility_log SELECT',
    ]);
    expect(await catalogProblems(db.owner, ALLOW_LISTS)).toEqual([]);
  });

  it('holds each value to the two visibilities and one change per key', async () => {
    const db = await dbs.fresh('migrated');
    const checks = await superuser(
      `select conname || ' ' || pg_get_constraintdef(oid) from pg_constraint
        where conrelid in ('app.site_access'::regclass, 'app.visibility_log'::regclass)
          and contype in ('c', 'u') order by conname;`,
      db.name,
    );
    expect(lines(checks)).toEqual(
      expect.arrayContaining([
        "site_access_default_visibility_check CHECK ((default_visibility = ANY (ARRAY['public'::text, 'protected'::text])))",
        'visibility_log_idempotency_key UNIQUE (organization_id, project_id, idempotency_key)',
        'visibility_log_site_override_check CHECK (((node_id IS NOT NULL) OR (override IS NOT NULL)))',
      ]),
    );
  });

  it('keeps each tenant to its own rows, and refuses a value that is not a visibility', async () => {
    const db = await dbs.fresh('migrated');
    await seed(db.name, seedTenantsSql([A, B]));
    const insert = (t: typeof A, value: string) =>
      asApp(
        db,
        t.org,
        t.project,
        `insert into app.site_access (organization_id, project_id, default_visibility)
           values ('${t.org}', '${t.project}', '${value}');`,
      );
    expect(await insert(A, 'protected')).toBe('');
    expect(await insert(B, 'secret')).toMatch(/site_access_default_visibility_check/);
    expect(
      await asApp(
        db,
        B.org,
        B.project,
        `insert into app.site_access (organization_id, project_id, default_visibility)
           values ('${A.org}', '${A.project}', 'public');`,
      ),
    ).toMatch(/row-level security/);
    expect(await asApp(db, B.org, B.project, 'select count(*) from app.site_access;')).toBe('0');
    expect(await asApp(db, A.org, A.project, 'select count(*) from app.site_access;')).toBe('1');

    const log = (t: typeof A, nodeId: string | null, override: string | null) =>
      asApp(
        db,
        t.org,
        t.project,
        `insert into app.visibility_log (organization_id, project_id, node_id, override,
             effective, widened, nodes_changed, actor_kind, actor_id, idempotency_key)
           values ('${t.org}', '${t.project}', ${nodeId === null ? 'null' : `'${nodeId}'`},
             ${override === null ? 'null' : `'${override}'`}, 'protected', false, 0, 'user',
             '${A.org}', 'k1');`,
      );
    expect(await log(A, A.node, null)).toBe('');
    expect(await log(A, null, null)).toMatch(/visibility_log_site_override_check/);
    expect(await log(A, A.node, 'protected')).toMatch(/visibility_log_idempotency_key/);
    expect(await log(B, A.node, 'protected')).toMatch(/visibility_log_node_fkey|row-level/);
    expect(await asApp(db, A.org, A.project, 'delete from app.visibility_log;')).toMatch(
      /permission denied/,
    );
    expect(
      await asApp(db, A.org, A.project, `update app.visibility_log set widened = true;`),
    ).toMatch(/permission denied/);
  });

  it('reverts cleanly and applies again', async () => {
    const db = await dbs.fresh('migrated');
    await step(db, ['migrate', 'down', String(stepsBack())]);
    const left = await superuser(
      `select count(*) from pg_tables where schemaname = 'app' and tablename in ${IN};`,
      db.name,
    );
    expect(left.trim()).toBe('0');
    await step(db, ['migrate', 'up']);
    expect(await grants(db)).toHaveLength(6);
  });
});
