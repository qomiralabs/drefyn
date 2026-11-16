import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { runMaintain } from '../../src/filter-maintenance.ts';
import { describeFailure, migrate, shippedMigrations } from './support/cli.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { superuser } from './support/stack.ts';

const dbs = databases();

const step = async (db: TestDatabase, args: readonly string[]) => {
  const result = await migrate(args, { url: db.owner });
  expect(result.code, describeFailure(result)).toBe(0);
};

function stepsBack(): number {
  const shipped = shippedMigrations();
  const at = shipped.findIndex((file) => file.endsWith('_engine_filter_fields.sql'));
  expect(at).toBeGreaterThanOrEqual(0);
  return shipped.length - at;
}

const query = async (db: TestDatabase, text: string) => (await superuser(text, db.name)).trim();

const keyColumns = (db: TestDatabase) =>
  query(db, `select pg_get_indexdef('app.node_filter_rows_pkey'::regclass);`);

const tableExists = (db: TestDatabase, name: string) =>
  query(db, `select to_regclass('app.${name}') is not null;`);

const columnExists = (db: TestDatabase, table: string, column: string) =>
  query(
    db,
    `select count(*) from information_schema.columns
     where table_schema = 'app' and table_name = '${table}' and column_name = '${column}';`,
  );

describeWithStack('the engine filter fields migration', () => {
  it('adds the list columns inside the key, and down restores the old key', async () => {
    const db = await dbs.fresh('migrated');
    expect(await keyColumns(db)).toContain('l5');
    expect(await tableExists(db, 'filter_backfills')).toBe('t');
    expect(await columnExists(db, 'nodes', 'head_fields')).toBe('1');

    await step(db, ['migrate', 'down', String(stepsBack())]);
    const old = await keyColumns(db);
    expect(old).not.toContain('l1');
    expect(old).toContain('d2');
    expect(await tableExists(db, 'filter_backfills')).toBe('f');
    expect(await columnExists(db, 'nodes', 'head_fields')).toBe('0');
    expect(await columnExists(db, 'node_versions', 'fields')).toBe('0');
    expect(await columnExists(db, 'content_types', 'content_schema')).toBe('0');

    await step(db, ['migrate', 'up']);
    expect(await keyColumns(db)).toContain('l5');
  });

  it('gives a node from before it a filter row, so lists can see it', async () => {
    const db = await dbs.fresh('migrated');
    await step(db, ['migrate', 'down', String(stepsBack())]);
    const [organization, project, type] = [randomUUID(), randomUUID(), randomUUID()];
    await superuser(
      `insert into app.organizations (organization_id, name, plan_tier)
         values ('${organization}', 'Org', 'self_hosted');
       insert into app.projects (id, organization_id, product, slug, name)
         values ('${project}', '${organization}', 'studio', 'old', 'Old');
       insert into app.content_types (id, organization_id, project_id, family, key)
         values ('${type}', '${organization}', '${project}', 'studio_item', 'item');
       insert into app.nodes (organization_id, project_id, family, type_id, order_key, lifecycle)
         values ('${organization}', '${project}', 'studio_item', '${type}', 'a', 'draft');`,
      db.name,
    );
    await step(db, ['migrate', 'up']);
    expect(await query(db, `select count(*) from app.node_filter_rows;`)).toBe('1');
    expect(
      await query(
        db,
        `select relforcerowsecurity from pg_class
         where oid in ('app.nodes'::regclass, 'app.node_filter_rows'::regclass);`,
      ),
    ).toBe('t\nt');
  });

  it('holds one running backfill per organization across projects', async () => {
    const db = await dbs.fresh('migrated');
    const definition = await query(
      db,
      `select indexdef from pg_indexes where indexname = 'filter_backfills_one_running';`,
    );
    expect(definition).toContain('UNIQUE');
    expect(definition).toContain('(organization_id)');
  });

  it('the maintenance command runs for real as the owner', async () => {
    const db = await dbs.fresh('migrated');
    const lines: string[] = [];
    const code = await runMaintain({
      argv: ['maintain', 'filter-rows', '--after-import'],
      env: { DREFYN_MIGRATION_DATABASE_URL: db.owner, DREFYN_DATABASE_SSL: 'disable' },
      stdout: { write: (text: string) => lines.push(text) },
      stderr: { write: (text: string) => lines.push(text) },
    });
    expect(code, lines.join('')).toBe(0);
    expect(JSON.parse(lines.join(''))).toMatchObject({ ran: true, vacuum: true, reindex: true });
    expect(await keyColumns(db)).toContain('l5');
  });
});
