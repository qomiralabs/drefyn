import { expect, it } from 'vitest';
import { openTypesDatabase } from '../../src/types-check.ts';
import { describeFailure, fixtureMigrations, migrate, migration } from './support/cli.ts';
import { databases } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { run } from './support/process.ts';
import { migrationState } from './support/sql.ts';
import { packageRoot, schemaDump } from './support/stack.ts';

const dbs = databases();

function checkTypes(url: string, migrationsDir?: string) {
  return run(
    'pnpm',
    [
      'run',
      '--silent',
      'check:types',
      ...(migrationsDir === undefined ? [] : ['--migrations-dir', migrationsDir]),
    ],
    {
      cwd: packageRoot,
      env: { ...process.env, DREFYN_MIGRATION_DATABASE_URL: url, DREFYN_DATABASE_SSL: 'disable' },
    },
  );
}

describeWithStack('check:types', () => {
  it('passes when the committed types match the migrated schema', async () => {
    const db = await dbs.fresh('base');
    const result = await checkTypes(db.owner);
    expect(result.code, describeFailure(result)).toBe(0);
  });

  it('fails naming the table when a migration lands without regenerated types', async () => {
    const db = await dbs.fresh('base');
    const dir = fixtureMigrations({
      '9000000000001_widgets.sql': migration(
        'create table app.widgets (id uuid primary key default uuidv7(), name text not null);',
        'drop table app.widgets;',
      ),
    });
    const result = await checkTypes(db.owner, dir);
    expect(result.code, describeFailure(result)).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('widgets');
  });
});

// check:types migrates the database it is given, so it must refuse one that already has
// history: that may be a live database pointed at by mistake.
describeWithStack('check:types on a database that is not empty', () => {
  it('exits 1 saying so and applies nothing', async () => {
    const db = await dbs.fresh('migrated');
    const state = await migrationState(db.owner);
    const dump = await schemaDump(db.name);
    const dir = fixtureMigrations({
      '9000000000001_widgets.sql': migration(
        'create table app.widgets (id int);',
        'drop table app.widgets;',
      ),
    });

    const result = await checkTypes(db.owner, dir);
    expect(result.code, describeFailure(result)).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/not empty/i);
    expect(await migrationState(db.owner)).toEqual(state);
    expect(await schemaDump(db.name)).toBe(dump);
  });
});

// Domains are read through to their final base type, however deep, for columns and for array
// elements; a base type the map does not know stops check:types the same way as a plain one.
describeWithStack('check:types and domains', () => {
  const domains = migration(
    `create domain app.label as text;
create domain app.short_label as app.label check (length(value) < 10);
create domain app.span as int4range;
create domain app.short_span as app.span;
create table app.labelled (a app.label not null, b app.short_label not null, c app.short_label[]);`,
    `drop table app.labelled;
drop domain app.short_span;
drop domain app.span;
drop domain app.short_label;
drop domain app.label;`,
  );

  it('reads a domain over a domain, and an array of one, as the final base type', async () => {
    const db = await dbs.fresh('base');
    const dir = fixtureMigrations({ '9000000000001_labelled.sql': domains });
    const up = await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir });
    expect(up.code, describeFailure(up)).toBe(0);
    const types = await openTypesDatabase({ url: db.owner, ssl: 'disable' });
    try {
      const columns = (await types.columns()).filter((c) => c.table === 'labelled');
      expect(columns.map((c) => [c.column, c.type, c.elementType])).toEqual([
        ['a', 'text', null],
        ['b', 'text', null],
        // The array type is named after the domain; its element is what resolves.
        ['c', '_short_label', 'text'],
      ]);
    } finally {
      await types.close();
    }
  });

  it.each([
    ['a domain', 'app.span'],
    ['a domain over a domain', 'app.short_span'],
    ['an array of a domain over a domain', 'app.short_span[]'],
  ])('exits 1 naming the column when %s ends in an unmapped type', async (_, type) => {
    const db = await dbs.fresh('base');
    const dir = fixtureMigrations({
      '9000000000001_labelled.sql': domains,
      '9000000000002_spans.sql': migration(
        `create table app.spans (during ${type});`,
        'drop table app.spans;',
      ),
    });
    const result = await checkTypes(db.owner, dir);
    expect(result.code, describeFailure(result)).toBe(1);
    expect(result.stderr).toContain(
      `app.spans.during (int4range${type.endsWith('[]') ? '[]' : ''})`,
    );
  });
});
