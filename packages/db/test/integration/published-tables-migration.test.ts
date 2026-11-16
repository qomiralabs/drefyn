import { expect, it } from 'vitest';
import { describeFailure, migrate, shippedMigrations } from './support/cli.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { superuser } from './support/stack.ts';

const dbs = databases();

const TABLES = ['published_filter_rows', 'published_versions'];

// Every table the reader may select from once all migrations ran, later ones included.
const READER_TABLES = [
  'published_chunk_terms',
  'published_chunks',
  'published_filter_rows',
  'published_project_term_totals',
  'published_term_stats',
  'published_versions',
];

// Every table in app the reader may touch, with what it may do there.
const readerGrants = (db: TestDatabase) =>
  superuser(
    `select coalesce(string_agg(table_name || ' ' || privilege_type, ',' order by table_name,
       privilege_type), '')
     from information_schema.role_table_grants
     where grantee = 'drefyn_public_reader' and table_schema = 'app';`,
    db.name,
  ).then((text) => text.trim());

const policies = (db: TestDatabase) =>
  superuser(
    `select coalesce(string_agg(tablename || ' ' || policyname || ' ' || cmd || ' ' ||
       array_to_string(roles, '+'), ',' order by tablename, policyname), '')
     from pg_policies where schemaname = 'app'
       and tablename in (${TABLES.map((t) => `'${t}'`).join(', ')});`,
    db.name,
  ).then((text) => text.trim());

const step = async (db: TestDatabase, args: readonly string[]) => {
  const result = await migrate(args, { url: db.owner });
  expect(result.code, describeFailure(result)).toBe(0);
};

function stepsBack(): number {
  const shipped = shippedMigrations();
  const at = shipped.findIndex((file) => file.endsWith('_published_tables.sql'));
  expect(at).toBeGreaterThanOrEqual(0);
  return shipped.length - at;
}

describeWithStack('the published tables migration', () => {
  it('grants the reader select on both tables and nothing else, under its own policy', async () => {
    const db = await dbs.fresh('migrated');
    expect(await readerGrants(db)).toBe(READER_TABLES.map((t) => `${t} SELECT`).join(','));
    expect(await policies(db)).toBe(
      [
        'published_filter_rows published_read SELECT drefyn_public_reader',
        'published_filter_rows tenant_isolation ALL drefyn_app',
        'published_versions published_read SELECT drefyn_public_reader',
        'published_versions tenant_isolation ALL drefyn_app',
      ].join(','),
    );
  });

  it('allows one current version per node and refuses a version of another node', async () => {
    const db = await dbs.fresh('migrated');
    const indexes = await superuser(
      `select indexname from pg_indexes where schemaname = 'app'
         and tablename in ('published_versions', 'published_filter_rows') order by 1;`,
      db.name,
    );
    expect(indexes.trim().split('\n')).toEqual([
      'published_filter_rows_pkey',
      'published_versions_current',
      'published_versions_pkey',
      'published_versions_version_key',
    ]);
    const keys = await superuser(
      `select conname from pg_constraint
       where conrelid = 'app.published_versions'::regclass and contype = 'f' order by 1;`,
      db.name,
    );
    expect(keys.trim().split('\n')).toEqual([
      'published_versions_node_fkey',
      'published_versions_project_fkey',
      'published_versions_version_fkey',
    ]);
  });

  it('reverts cleanly and applies again', async () => {
    const db = await dbs.fresh('migrated');
    await step(db, ['migrate', 'down', String(stepsBack())]);
    const left = await superuser(
      `select count(*) from pg_tables where schemaname = 'app' and tablename like 'published_%';`,
      db.name,
    );
    expect(left.trim()).toBe('0');
    expect(await readerGrants(db)).toBe('');
    await step(db, ['migrate', 'up']);
    expect(await readerGrants(db)).toBe(READER_TABLES.map((t) => `${t} SELECT`).join(','));
  });
});
