import { describe, expect, it } from 'vitest';
import {
  describeFailure,
  fixtureMigrations,
  migrate,
  migration,
  recordedName,
  shippedMigrations,
} from './support/cli.ts';
import { databases } from './support/databases.ts';
import { CHECKSUMS, MIGRATIONS, extensionState, migrationState, query } from './support/sql.ts';
import { schemaDump } from './support/stack.ts';

const dbs = databases();
const bookkeeping = [`${MIGRATIONS}*`, `${CHECKSUMS}*`];

describe('up, down, up', () => {
  it('leaves an identical schema dump and returns to the bootstrap schema on the way down', async () => {
    const db = await dbs.fresh('base');
    const shipped = shippedMigrations();
    expect(shipped.length).toBeGreaterThan(0);
    const before = await schemaDump(db.name, bookkeeping);
    const extensionsBefore = await extensionState(db.owner);

    const up = await migrate(['migrate', 'up'], { url: db.owner });
    expect(up.code, describeFailure(up)).toBe(0);
    const first = await schemaDump(db.name);
    expect(await schemaDump(db.name, bookkeeping)).not.toBe(before);

    const down = await migrate(['migrate', 'down', String(shipped.length)], { url: db.owner });
    expect(down.code, describeFailure(down)).toBe(0);
    expect(await schemaDump(db.name, bookkeeping)).toBe(before);
    expect((await migrationState(db.owner))?.applied).toEqual([]);

    const again = await migrate(['migrate', 'up'], { url: db.owner });
    expect(again.code, describeFailure(again)).toBe(0);
    expect(await schemaDump(db.name)).toBe(first);
    expect((await migrationState(db.owner))?.applied).toEqual(shipped.map(recordedName));

    // Migrations never touch pgvector or its schema, in either direction.
    expect(await extensionState(db.owner)).toEqual(extensionsBefore);
  });

  it('round trips every fixture migration too, one step at a time', async () => {
    const db = await dbs.fresh('base');
    const dir = fixtureMigrations({
      '9000000000001_widgets.sql': migration(
        'create table app.widgets (id uuid primary key default uuidv7(), name text not null);',
        'drop table app.widgets;',
      ),
      '9000000000002_widgets_name.sql': migration(
        'create index widgets_name_idx on app.widgets (name);',
        'drop index app.widgets_name_idx;',
      ),
    });
    expect((await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir })).code).toBe(0);
    const top = await schemaDump(db.name);

    const one = await migrate(['migrate', 'down'], { url: db.owner, migrationsDir: dir });
    expect(one.code, describeFailure(one)).toBe(0);
    const applied = (await migrationState(db.owner))?.applied ?? [];
    expect(applied.at(-1)).toBe('9000000000001_widgets');
    expect(await query(db.owner, "select to_regclass('app.widgets_name_idx') as i")).toEqual([
      { i: null },
    ]);

    expect((await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir })).code).toBe(0);
    expect(await schemaDump(db.name)).toBe(top);
  });

  it('does nothing on a second up', async () => {
    const db = await dbs.fresh('base');
    expect((await migrate(['migrate', 'up'], { url: db.owner })).code).toBe(0);
    const dump = await schemaDump(db.name);
    const state = await migrationState(db.owner);
    const second = await migrate(['migrate', 'up'], { url: db.owner });
    expect(second.code, describeFailure(second)).toBe(0);
    expect(await schemaDump(db.name)).toBe(dump);
    expect(await migrationState(db.owner)).toEqual(state);
  });

  it('does nothing on a down with nothing applied', async () => {
    const db = await dbs.fresh('base');
    const dump = await schemaDump(db.name, bookkeeping);
    const down = await migrate(['migrate', 'down'], { url: db.owner });
    expect(down.code, describeFailure(down)).toBe(0);
    expect(await schemaDump(db.name, bookkeeping)).toBe(dump);
  });

  it('reports pending and applied files in status', async () => {
    const db = await dbs.fresh('base');
    const [first] = shippedMigrations();
    expect(first).toBeDefined();
    const name = recordedName(first ?? '');
    const pending = await migrate(['migrate', 'status'], { url: db.owner });
    expect(pending.code, describeFailure(pending)).toBe(0);
    expect(pending.stdout).toMatch(new RegExp(`^.*pending.*${name}.*$`, 'm'));
    // Status reads; it never creates the bookkeeping tables or applies anything.
    expect(await migrationState(db.owner)).toBeNull();

    expect((await migrate(['migrate', 'up'], { url: db.owner })).code).toBe(0);
    const applied = await migrate(['migrate', 'status'], { url: db.owner });
    expect(applied.code, describeFailure(applied)).toBe(0);
    expect(applied.stdout).toMatch(new RegExp(`^.*applied.*${name}.*$`, 'm'));
  });

  it('leaves every object it creates owned by drefyn_owner', async () => {
    const db = await dbs.fresh('base');
    expect((await migrate(['migrate', 'up'], { url: db.owner })).code).toBe(0);
    const owners = await query<{ owner: string }>(
      db.owner,
      `select distinct pg_get_userbyid(relowner) as owner from pg_class where relnamespace = 'app'::regnamespace
       union select distinct pg_get_userbyid(proowner) from pg_proc where pronamespace = 'app'::regnamespace`,
    );
    expect(owners.map((o) => o.owner)).toEqual(['drefyn_owner']);
  });
});
