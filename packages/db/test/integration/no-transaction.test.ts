import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { NO_TRANSACTION_MARKER } from '../../src/migration-file.ts';
import {
  describeFailure,
  fixtureMigrations,
  migrate,
  migration,
  recordedName,
} from './support/cli.ts';
import { databases } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { CHECKSUMS, MIGRATIONS, migrateLockRows, migrationState, query } from './support/sql.ts';
import { schemaDump } from './support/stack.ts';

const dbs = databases();

const TABLE = '9000000000001_widgets.sql';
const INDEX = '9000000000002_widgets_name_idx.sql';
const TWO = '9000000000002_widgets_two_idx.sql';

const table = migration(
  'create table app.widgets (id int primary key, name text not null);',
  'drop table app.widgets;',
);

// One statement per section, each safe to repeat, as a marked file must be.
const concurrentIndex = `${NO_TRANSACTION_MARKER}\n${migration(
  'create index concurrently if not exists widgets_name_idx on app.widgets (name);',
  'drop index concurrently if exists app.widgets_name_idx;',
)}`;

// Postgres runs a multi statement string as one implicit transaction, which a concurrent
// index build refuses, so neither index may appear.
const twoConcurrent = `${NO_TRANSACTION_MARKER}\n${migration(
  'create index concurrently if not exists widgets_a_idx on app.widgets (name);\ncreate index concurrently if not exists widgets_b_idx on app.widgets (id, name);',
  'drop index concurrently if exists app.widgets_a_idx;',
)}`;

async function indexValid(url: string, qualified: string): Promise<boolean | null> {
  const rows = await query<{ valid: boolean | null }>(
    url,
    `select (select indisvalid from pg_index where indexrelid = to_regclass($1)) as valid`,
    [qualified],
  );
  return rows[0]?.valid ?? null;
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

describeWithStack('files marked to run outside a transaction', () => {
  it('builds a concurrent index, records it, and round trips to the same schema', async () => {
    const db = await dbs.fresh('base');
    const dir = fixtureMigrations({ [TABLE]: table, [INDEX]: concurrentIndex });

    const up = await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir });
    expect(up.code, describeFailure(up)).toBe(0);
    expect(await indexValid(db.owner, 'app.widgets_name_idx')).toBe(true);
    const state = await migrationState(db.owner);
    expect(state?.applied).toContain(recordedName(INDEX));
    expect(state?.checksums).toContainEqual({
      name: recordedName(INDEX),
      sha256: sha256(join(dir, INDEX)),
    });
    const first = await schemaDump(db.name);

    const down = await migrate(['migrate', 'down'], { url: db.owner, migrationsDir: dir });
    expect(down.code, describeFailure(down)).toBe(0);
    expect(await indexValid(db.owner, 'app.widgets_name_idx')).toBeNull();
    const after = await migrationState(db.owner);
    expect(after?.applied).not.toContain(recordedName(INDEX));
    expect(after?.applied).toContain(recordedName(TABLE));
    expect(after?.checksums.map((c) => c.name)).not.toContain(recordedName(INDEX));

    const again = await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir });
    expect(again.code, describeFailure(again)).toBe(0);
    expect(await indexValid(db.owner, 'app.widgets_name_idx')).toBe(true);
    expect(await schemaDump(db.name)).toBe(first);
    expect(await migrateLockRows(db.owner)).toEqual([]);
  });

  it('exits 1 for two concurrent statements in one section, leaving no index, record or checksum', async () => {
    const db = await dbs.fresh('base');
    const dir = fixtureMigrations({ [TABLE]: table, [TWO]: twoConcurrent });

    const result = await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir });
    expect(result.code, describeFailure(result)).toBe(1);
    expect(result.stderr).toContain(recordedName(TWO));
    expect(result.stdout + result.stderr).toMatch(/cannot run inside a transaction block/i);
    expect(await indexValid(db.owner, 'app.widgets_a_idx')).toBeNull();
    expect(await indexValid(db.owner, 'app.widgets_b_idx')).toBeNull();
    const state = await migrationState(db.owner);
    expect(state?.applied).toContain(recordedName(TABLE));
    expect(state?.applied).not.toContain(recordedName(TWO));
    expect(state?.checksums.map((c) => c.name)).not.toContain(recordedName(TWO));
    expect(await migrateLockRows(db.owner)).toEqual([]);
  });

  // A crash after the index is built but before both records are written leaves the file
  // run and unrecorded; the next up repeats it, which the marked file's rules make safe.
  it('repeats a marked file whose records were lost after it ran', async () => {
    const db = await dbs.fresh('base');
    const dir = fixtureMigrations({ [TABLE]: table, [INDEX]: concurrentIndex });
    expect((await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir })).code).toBe(0);
    const expected = await migrationState(db.owner);
    await query(db.owner, `delete from ${MIGRATIONS} where name = $1`, [recordedName(INDEX)]);
    await query(db.owner, `delete from ${CHECKSUMS} where name = $1`, [recordedName(INDEX)]);

    const result = await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir });
    expect(result.code, describeFailure(result)).toBe(0);
    expect(await indexValid(db.owner, 'app.widgets_name_idx')).toBe(true);
    const state = await migrationState(db.owner);
    expect(state?.applied).toEqual(expected?.applied);
    expect(state?.checksums).toEqual(expected?.checksums);
  });

  // The checksum is an upsert for marked files, so a hash left behind by the crashed run
  // does not stop the repeat on its key.
  it('repeats a marked file whose checksum survived but whose record did not', async () => {
    const db = await dbs.fresh('base');
    const dir = fixtureMigrations({ [TABLE]: table, [INDEX]: concurrentIndex });
    expect((await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir })).code).toBe(0);
    const expected = await migrationState(db.owner);
    await query(db.owner, `delete from ${MIGRATIONS} where name = $1`, [recordedName(INDEX)]);

    const result = await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir });
    expect(result.code, describeFailure(result)).toBe(0);
    const state = await migrationState(db.owner);
    expect(state?.applied).toEqual(expected?.applied);
    expect(state?.checksums).toEqual(expected?.checksums);
  });
});
