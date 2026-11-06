import { expect, it } from 'vitest';
import { describeFailure, migrate } from './support/cli.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { superuser } from './support/stack.ts';

const dbs = databases();

const COLUMNS = ['nodes.head_content', 'node_versions.content'];

// '' is the server default, and 'l' is lz4.
const compressionOf = async (db: TestDatabase) =>
  (
    await superuser(
      `select c.relname || '.' || a.attname || '=' || a.attcompression::text
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'app'
         and (c.relname, a.attname) in (('nodes', 'head_content'), ('node_versions', 'content'))
       order by c.relname desc;`,
      db.name,
    )
  )
    .trim()
    .split('\n');

const step = async (db: TestDatabase, args: readonly string[]) => {
  const result = await migrate(args, { url: db.owner });
  expect(result.code, describeFailure(result)).toBe(0);
};

describeWithStack('the engine lz4 migration', () => {
  it('sets lz4 on both content columns, and down puts the default back', async () => {
    const db = await dbs.fresh('migrated');
    expect(await compressionOf(db)).toEqual(COLUMNS.map((column) => `${column}=l`));

    await step(db, ['migrate', 'down', '1']);
    expect(await compressionOf(db)).toEqual(COLUMNS.map((column) => `${column}=`));

    await step(db, ['migrate', 'up']);
    expect(await compressionOf(db)).toEqual(COLUMNS.map((column) => `${column}=l`));
  });
});
