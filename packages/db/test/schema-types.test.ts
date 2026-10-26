import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareRenderings, renderSchema, type CatalogColumn } from '../src/schema-types.ts';
import { committedTypesPath, runCheckTypes, type TypesDatabase } from '../src/types-check.ts';
import type { Output } from '../src/run.ts';
import { migrationsDir } from './support.ts';

const col = (over: Partial<CatalogColumn> & Pick<CatalogColumn, 'table' | 'column'>) => ({
  type: 'text',
  elementType: null,
  enumLabels: null,
  nullable: false,
  hasDefault: false,
  ...over,
});

const widgets: CatalogColumn[] = [
  col({ table: 'widgets', column: 'id', type: 'uuid', hasDefault: true }),
  col({ table: 'widgets', column: 'amount_cents', type: 'int8' }),
  col({ table: 'widgets', column: 'created_at', type: 'timestamptz', hasDefault: true }),
  col({ table: 'widgets', column: 'payload', type: 'jsonb', nullable: true }),
  col({ table: 'widgets', column: 'embedding', type: 'vector', nullable: true }),
  col({ table: 'widgets', column: 'tags', type: '_text', elementType: 'text' }),
  col({ table: 'widgets', column: 'state', type: 'widget_state', enumLabels: ['on', 'off'] }),
  col({ table: 'widgets', column: 'odd name', type: 'mystery' }),
];

describe('renderSchema', () => {
  it('maps each column, keeping int8 a number and marking defaults', () => {
    const text = renderSchema(widgets);
    expect(text).toContain(
      [
        '// app.widgets',
        'export interface WidgetsTable {',
        '  id: Generated<string>;',
        '  amount_cents: number;',
        '  created_at: Generated<Date>;',
        '  payload: JsonValue | null;',
        '  embedding: string | null;',
        '  tags: string[];',
        "  state: 'on' | 'off';",
        "  'odd name': unknown;",
        '}',
      ].join('\n'),
    );
    expect(text).toContain('export interface Schema {\n  widgets: WidgetsTable;\n}');
  });

  it('leaves out the bookkeeping tables and sorts the rest', () => {
    const text = renderSchema([
      col({ table: 'zeta', column: 'id' }),
      col({ table: 'pgmigrations', column: 'id' }),
      col({ table: 'migration_checksums', column: 'name' }),
      col({ table: 'alpha', column: 'id' }),
    ]);
    expect(text).not.toContain('pgmigrations');
    expect(text).not.toContain('migration_checksums');
    expect(text.indexOf('app.alpha')).toBeLessThan(text.indexOf('app.zeta'));
  });

  it('is deterministic and says when there are no tables', () => {
    expect(renderSchema(widgets)).toBe(renderSchema(widgets));
    expect(renderSchema([])).toContain('export type Schema = Record<string, never>;');
  });

  it('wraps an array of enums and breaks a long union across lines', () => {
    const labels = Array.from({ length: 12 }, (_, i) => `state_number_${String(i)}`);
    const text = renderSchema([
      col({ table: 't', column: 'many', type: 'big', enumLabels: labels }),
      col({ table: 't', column: 'list', type: '_e', elementType: 'e', enumLabels: ['a', 'b'] }),
      col({ table: 't', column: 'none', type: 'e', enumLabels: [] }),
    ]);
    expect(text).toContain("  many:\n    | 'state_number_0'\n");
    expect(text).toContain("  list: ('a' | 'b')[];");
    expect(text).toContain('  none: never;');
  });

  it('keeps interface names distinct when two tables spell the same', () => {
    const text = renderSchema([
      col({ table: 'a_b', column: 'x' }),
      col({ table: 'ab', column: 'x' }),
    ]);
    expect(text).toContain('export interface ABTable {');
    expect(text).toContain('export interface AbTable {');
    const clash = renderSchema([
      col({ table: 'a_b', column: 'x' }),
      col({ table: 'a__b', column: 'x' }),
    ]);
    expect(clash).toMatch(/export interface ABTable1 \{/);
  });

  it('matches the committed file for the shipped migrations, which add no tables', () => {
    expect(readFileSync(committedTypesPath, 'utf8')).toBe(renderSchema([]));
  });
});

describe('compareRenderings', () => {
  it('names each table that differs, is new, or is gone', () => {
    const before = renderSchema([
      col({ table: 'a', column: 'x' }),
      col({ table: 'b', column: 'x' }),
    ]);
    const after = renderSchema([
      col({ table: 'a', column: 'x', nullable: true }),
      col({ table: 'c', column: 'x' }),
    ]);
    expect(compareRenderings(before, after)).toEqual({ tables: ['a', 'b', 'c'], elsewhere: false });
  });

  it('reports an edit outside the tables', () => {
    const text = renderSchema([col({ table: 'a', column: 'x' })]);
    expect(compareRenderings(`${text}// hand edit\n`, text)).toEqual({
      tables: [],
      elsewhere: true,
    });
    expect(compareRenderings(text, text)).toEqual({ tables: [], elsewhere: false });
  });
});

function capture(): Output & { text: () => string } {
  const chunks: string[] = [];
  return { write: (t: string) => void chunks.push(t), text: () => chunks.join('') };
}

const ENV = {
  DREFYN_MIGRATION_DATABASE_URL: 'postgres://drefyn_owner:pw-1414-secret@127.0.0.1:1/drefyn',
  DREFYN_DATABASE_SSL: 'disable',
};

function fakeDatabase(rows: number | null, columns: CatalogColumn[]) {
  const opened: string[] = [];
  const open = (): Promise<TypesDatabase> => {
    opened.push('open');
    return Promise.resolve({
      migrationRows: () => Promise.resolve(rows),
      columns: () => Promise.resolve(columns),
      close: () => Promise.resolve(),
    });
  };
  return { open, opened };
}

async function check(
  argv: string[],
  db: ReturnType<typeof fakeDatabase>,
  typesPath: string,
  migrateCode = 0,
) {
  const stdout = capture();
  const stderr = capture();
  const migrations: (readonly string[])[] = [];
  const code = await runCheckTypes({
    argv,
    env: ENV,
    stdout,
    stderr,
    open: db.open,
    migrate: (args) => {
      migrations.push(args);
      return Promise.resolve(migrateCode);
    },
    typesPath,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text(), migrations };
}

describe('runCheckTypes', () => {
  const typesFile = (text: string) => {
    const path = join(migrationsDir({}), 'schema.generated.ts');
    writeFileSync(path, text);
    return path;
  };

  it('migrates an empty database and passes when the types match', async () => {
    const r = await check(
      ['--migrations-dir', '/m'],
      fakeDatabase(null, widgets),
      typesFile(renderSchema(widgets)),
    );
    expect(r.code).toBe(0);
    expect(r.migrations).toEqual([['migrate', 'up', '--migrations-dir', '/m']]);
    expect(r.stdout).toMatch(/match/);
  });

  it('fails naming each table that differs', async () => {
    const r = await check([], fakeDatabase(0, widgets), typesFile(renderSchema([])));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('widgets');
    expect(r.stderr).toContain('--write');
  });

  it('fails on a hand edit outside the tables, or a missing file', async () => {
    const edited = await check([], fakeDatabase(0, []), typesFile(`${renderSchema([])}// x\n`));
    expect(edited.code).toBe(1);
    expect(edited.stderr).toMatch(/outside its tables/);
    const missing = await check([], fakeDatabase(0, widgets), '/nonexistent/schema.generated.ts');
    expect(missing.code).toBe(1);
  });

  it('refuses a database with migration history before migrating it', async () => {
    const db = fakeDatabase(3, widgets);
    const r = await check([], db, typesFile(''));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not empty/);
    expect(r.migrations).toEqual([]);
    expect(db.opened).toHaveLength(1);
  });

  it('passes on a failed migrate run with its own code', async () => {
    const r = await check([], fakeDatabase(null, []), typesFile(''), 4);
    expect(r.code).toBe(4);
  });

  it('writes the file with --write', async () => {
    const path = typesFile('');
    const r = await check(['--write'], fakeDatabase(null, widgets), path);
    expect(r.code).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(renderSchema(widgets));
  });

  it.each([[['--write', '--write']], [['--force']], [['--migrations-dir']]])(
    'refuses %j',
    async (argv) => {
      const r = await check(argv, fakeDatabase(null, []), typesFile(''));
      expect(r.code).toBe(1);
      expect(r.migrations).toEqual([]);
    },
  );

  it('reports bad config by code without the URL', async () => {
    const stderr = capture();
    const code = await runCheckTypes({ argv: [], env: {}, stdout: capture(), stderr });
    expect(code).toBe(1);
    expect(stderr.text()).toContain('DB_CONFIG_INVALID');
  });

  it('exits 1 without the password when the server is unreachable', async () => {
    const stderr = capture();
    const code = await runCheckTypes({ argv: [], env: ENV, stdout: capture(), stderr });
    expect(code).toBe(1);
    expect(stderr.text()).not.toContain('pw-1414-secret');
  });
});
