import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  describeFailure,
  fixtureMigrations,
  migrate,
  migration,
  recordedName,
  shippedMigrations,
} from './support/cli.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { migrationState, tableExists } from './support/sql.ts';
import { schemaDump } from './support/stack.ts';

const dbs = databases();
const WIDGETS = '9000000000001_widgets.sql';
const GADGETS = '9000000000002_gadgets.sql';

async function appliedWithWidgets(): Promise<{ db: TestDatabase; dir: string }> {
  const db = await dbs.fresh('base');
  const dir = fixtureMigrations({
    [WIDGETS]: migration('create table app.widgets (id int);', 'drop table app.widgets;'),
  });
  const up = await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir });
  expect(up.code, describeFailure(up)).toBe(0);
  return { db, dir };
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('checksums', () => {
  it('records the SHA-256 of every applied file', async () => {
    const { db, dir } = await appliedWithWidgets();
    const state = await migrationState(db.owner);
    const files = [...shippedMigrations(), WIDGETS];
    expect(state?.checksums).toEqual(
      files
        .map((f) => ({ name: recordedName(f), sha256: sha256(join(dir, f)) }))
        .sort((a, b) => (a.name < b.name ? -1 : 1)),
    );
  });

  it.each([
    ['a fixture', WIDGETS],
    ['the first shipped migration', 'first-shipped'],
  ])('exits 3 naming %s once it is edited, and applies nothing', async (_, which) => {
    const { db, dir } = await appliedWithWidgets();
    const edited = which === 'first-shipped' ? (shippedMigrations()[0] ?? '') : which;
    appendFileSync(join(dir, edited), '-- edited after it ran\n');
    // A new pending file must not slip through either.
    writeFileSync(
      join(dir, GADGETS),
      migration('create table app.gadgets (id int);', 'drop table app.gadgets;'),
    );
    const state = await migrationState(db.owner);
    const dump = await schemaDump(db.name);

    const result = await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir });
    expect(result.code, describeFailure(result)).toBe(3);
    expect(result.stderr).toContain(edited);
    expect(await migrationState(db.owner)).toEqual(state);
    expect(await schemaDump(db.name)).toBe(dump);
    expect(await tableExists(db.owner, 'app.gadgets')).toBe(false);
  });

  it('counts a line ending change as an edit', async () => {
    const { db, dir } = await appliedWithWidgets();
    const path = join(dir, WIDGETS);
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('\n', '\r\n'));
    const result = await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir });
    expect(result.code, describeFailure(result)).toBe(3);
    expect(result.stderr).toContain(WIDGETS);
  });

  it('exits 3 on down and reverts nothing', async () => {
    const { db, dir } = await appliedWithWidgets();
    appendFileSync(join(dir, WIDGETS), '-- edited\n');
    const result = await migrate(['migrate', 'down'], { url: db.owner, migrationsDir: dir });
    expect(result.code, describeFailure(result)).toBe(3);
    expect(result.stderr).toContain(WIDGETS);
    expect(await tableExists(db.owner, 'app.widgets')).toBe(true);
  });

  it('exits 3 on status, naming the file', async () => {
    const { db, dir } = await appliedWithWidgets();
    appendFileSync(join(dir, WIDGETS), '-- edited\n');
    const result = await migrate(['migrate', 'status'], { url: db.owner, migrationsDir: dir });
    expect(result.code, describeFailure(result)).toBe(3);
    expect(result.stderr).toContain(WIDGETS);
  });

  it('exits 3 when an applied file is deleted', async () => {
    const { db, dir } = await appliedWithWidgets();
    rmSync(join(dir, WIDGETS));
    const state = await migrationState(db.owner);
    const result = await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir });
    expect(result.code, describeFailure(result)).toBe(3);
    expect(result.stderr).toContain(recordedName(WIDGETS));
    expect(await migrationState(db.owner)).toEqual(state);
  });

  it('runs again once the edit is undone', async () => {
    const { db, dir } = await appliedWithWidgets();
    const path = join(dir, WIDGETS);
    const original = readFileSync(path);
    appendFileSync(path, '-- edited\n');
    expect((await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir })).code).toBe(3);
    writeFileSync(path, original);
    writeFileSync(
      join(dir, GADGETS),
      migration('create table app.gadgets (id int);', 'drop table app.gadgets;'),
    );
    const result = await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir });
    expect(result.code, describeFailure(result)).toBe(0);
    expect(await tableExists(db.owner, 'app.gadgets')).toBe(true);
  });
});
