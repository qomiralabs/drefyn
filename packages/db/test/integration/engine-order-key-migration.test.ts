import { expect, it } from 'vitest';
import { describeFailure, migrate, shippedMigrations } from './support/cli.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { superuser } from './support/stack.ts';

const dbs = databases();

// Empty means the column follows the database default, whatever that locale is.
const collationOf = (db: TestDatabase) =>
  superuser(
    `select coalesce((select c.collname from pg_attribute a
         join pg_collation c on c.oid = a.attcollation
       where a.attrelid = 'app.nodes'::regclass and a.attname = 'order_key'), '');`,
    db.name,
  ).then((text) => text.trim());

const step = async (db: TestDatabase, args: readonly string[]) => {
  const result = await migrate(args, { url: db.owner });
  expect(result.code, describeFailure(result)).toBe(0);
};

// However many have landed after it.
function stepsBack(): number {
  const shipped = shippedMigrations();
  const at = shipped.findIndex((file) => file.endsWith('_engine_order_key_collation.sql'));
  expect(at).toBeGreaterThanOrEqual(0);
  return shipped.length - at;
}

describeWithStack('the engine order key migration', () => {
  it('sorts order keys by bytes, and down gives the column back to the default', async () => {
    const db = await dbs.fresh('migrated');
    expect(await collationOf(db)).toBe('C');

    await step(db, ['migrate', 'down', String(stepsBack())]);
    expect(await collationOf(db)).toBe('default');

    await step(db, ['migrate', 'up']);
    expect(await collationOf(db)).toBe('C');
  });

  it('rebuilds both list indexes on the new order', async () => {
    const db = await dbs.fresh('migrated');
    const defs = await superuser(
      `select indexname || ' ' || indexdef from pg_indexes
       where schemaname = 'app' and indexname in ('nodes_roots', 'nodes_children')
       order by indexname;`,
      db.name,
    );
    expect(defs).toMatch(/nodes_children .*order_key COLLATE "C"|nodes_children .*order_key\)/);
    expect(defs).toMatch(/nodes_roots .*WHERE \(parent_id IS NULL\)/);
    const valid = await superuser(
      `select count(*) from pg_index i join pg_class c on c.oid = i.indexrelid
       where c.relname in ('nodes_roots', 'nodes_children') and i.indisvalid and i.indisready;`,
      db.name,
    );
    expect(valid.trim()).toBe('2');
  });
});
