import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NO_TRANSACTION_MARKER,
  loadMigrationFiles,
  parseMigrationFile,
} from '../src/migration-file.ts';
import { MigrateError } from '../src/outcome.ts';
import { migrationText, migrationsDir, rejected, thrown, utf8 } from './support.ts';

const NAME = '1760000000000_widgets.sql';
const UP = 'create table app.widgets (id uuid primary key default uuidv7());';
const DOWN = 'drop table app.widgets;';

function refusal(name: string, text: string | Uint8Array): MigrateError {
  const error = thrown(() =>
    parseMigrationFile(name, typeof text === 'string' ? utf8(text) : text),
  );
  expect(error).toBeInstanceOf(MigrateError);
  const migrate = error as MigrateError;
  expect(migrate.outcome).toBe('failed');
  expect(migrate.message).toContain(name);
  return migrate;
}

describe('parseMigrationFile', () => {
  it('splits a file into its up and down sections', () => {
    const file = parseMigrationFile(NAME, utf8(migrationText(UP, DOWN)));
    expect(file.name).toBe(NAME);
    expect(file.up).toContain(UP);
    expect(file.up).not.toContain(DOWN);
    expect(file.down).toContain(DOWN);
    expect(file.down).not.toContain(UP);
    expect(file.transaction).toBe(true);
  });

  it('hashes the exact bytes of the file', () => {
    const text = migrationText(UP, DOWN);
    const file = parseMigrationFile(NAME, utf8(text));
    expect(file.sha256).toBe(createHash('sha256').update(text).digest('hex'));
  });

  it('reads CRLF files and hashes them as they are', () => {
    const text = migrationText(UP, DOWN).replaceAll('\n', '\r\n');
    const file = parseMigrationFile(NAME, utf8(text));
    expect(file.up).toContain(UP);
    expect(file.down).toContain(DOWN);
    expect(file.sha256).not.toBe(parseMigrationFile(NAME, utf8(migrationText(UP, DOWN))).sha256);
  });

  it('allows comments before the up section', () => {
    const file = parseMigrationFile(NAME, utf8(`-- Adds widgets.\n\n${migrationText(UP, DOWN)}`));
    expect(file.up).toContain(UP);
  });

  it('refuses a file with no down section', () => {
    expect(refusal(NAME, `-- Up Migration\n${UP}\n`).message).toMatch(/down/i);
  });

  it('refuses a file with no up section', () => {
    expect(refusal(NAME, `-- Down Migration\n${DOWN}\n`).message).toMatch(/up/i);
  });

  it('refuses a file with no sections at all', () => {
    refusal(NAME, `${UP}\n`);
  });

  it('refuses an empty file', () => {
    refusal(NAME, '');
  });

  it('refuses a down section that comes first', () => {
    refusal(NAME, `-- Down Migration\n${DOWN}\n-- Up Migration\n${UP}\n`);
  });

  it('refuses a repeated section marker', () => {
    refusal(NAME, `${migrationText(UP, DOWN)}-- Down Migration\n${DOWN}\n`);
    refusal(NAME, `-- Up Migration\n${UP}\n-- Up Migration\n${UP}\n-- Down Migration\n${DOWN}\n`);
  });

  it.each([
    ['empty up', migrationText('', DOWN)],
    ['empty down', migrationText(UP, '')],
    ['comment only down', migrationText(UP, '-- nothing to undo')],
    ['whitespace only up', migrationText('   \n\t', DOWN)],
  ])('refuses an %s section', (_, text) => {
    refusal(NAME, text);
  });

  // The tool drops anything above the up marker, so that SQL would never run.
  it('refuses SQL above the up section', () => {
    refusal(NAME, `${UP}\n${migrationText(UP, DOWN)}`);
  });

  // The tool matches these loosely and would split the file at them; a stray comment that
  // reads like a marker would move SQL into the other direction.
  it.each([
    '-- up migration',
    '--- Up Migration',
    '--Up Migration',
    '-- UP MIGRATION',
    '  -- Up Migration',
    '-- Up   Migration',
    '-- Up Migrations',
    '-- - up migration notes',
  ])('refuses a near marker %j inside a section', (line) => {
    refusal(NAME, migrationText(UP, `${line}\n${DOWN}`));
  });

  it('refuses bytes that are not UTF-8', () => {
    const bytes = new Uint8Array([...utf8(migrationText(UP, DOWN)), 0xff, 0xfe]);
    refusal(NAME, bytes);
  });

  it.each([
    'create index concurrently widgets_name_idx on app.widgets (name);',
    'CREATE UNIQUE INDEX CONCURRENTLY widgets_key on app.widgets (id);',
    'drop index concurrently app.widgets_name_idx;',
    'reindex index concurrently app.widgets_name_idx;',
  ])('refuses non transactional SQL without the marker: %s', (statement) => {
    expect(refusal(NAME, migrationText(statement, 'select 1;')).message).toContain(
      NO_TRANSACTION_MARKER,
    );
  });

  it('accepts non transactional SQL marked to run outside a transaction', () => {
    const text = `${NO_TRANSACTION_MARKER}\n${migrationText(
      'create index concurrently if not exists widgets_name_idx on app.widgets (name);',
      'drop index concurrently if exists app.widgets_name_idx;',
    )}`;
    const file = parseMigrationFile(NAME, utf8(text));
    expect(file.transaction).toBe(false);
  });

  it('only honours the marker above the up section', () => {
    const text = migrationText(
      'create index concurrently widgets_name_idx on app.widgets (name);',
      `${NO_TRANSACTION_MARKER}\ndrop index concurrently app.widgets_name_idx;`,
    );
    refusal(NAME, text);
  });

  it.each([
    'widgets.sql',
    '1760000000000-widgets.sql',
    '1760000000000_Widgets.sql',
    '1760000000000_.sql',
    '1760000000000_widgets.SQL',
    '1760000000000_widgets.sql.bak',
  ])('refuses the file name %s', (name) => {
    refusal(name, migrationText(UP, DOWN));
  });
});

describe('loadMigrationFiles', () => {
  it('parses every file in name order', async () => {
    const dir = migrationsDir({
      '1760000000002_b.sql': migrationText('select 2;', 'select 2;'),
      '1760000000001_a.sql': migrationText('select 1;', 'select 1;'),
    });
    const files = await loadMigrationFiles(dir);
    expect(files.map((f) => f.name)).toEqual(['1760000000001_a.sql', '1760000000002_b.sql']);
  });

  it('refuses the whole folder when one file is missing a section', async () => {
    const dir = migrationsDir({
      '1760000000001_a.sql': migrationText('select 1;', 'select 1;'),
      '1760000000002_b.sql': '-- Up Migration\nselect 2;\n',
    });
    const error = await rejected(loadMigrationFiles(dir));
    expect(error).toBeInstanceOf(MigrateError);
    expect((error as MigrateError).message).toContain('1760000000002_b.sql');
  });

  // node-pg-migrate would run a .js or .ts file in this folder as code.
  it.each(['1760000000003_c.js', '1760000000003_c.ts', 'README.md', 'notes'])(
    'refuses a stray %s',
    async (stray) => {
      const dir = migrationsDir({
        '1760000000001_a.sql': migrationText('select 1;', 'select 1;'),
        [stray]: 'module.exports = {}',
      });
      const error = await rejected(loadMigrationFiles(dir));
      expect((error as MigrateError).message).toContain(stray);
    },
  );

  it('refuses a folder inside the migrations folder', async () => {
    const dir = migrationsDir({ '1760000000001_a.sql': migrationText('select 1;', 'select 1;') });
    mkdirSync(join(dir, 'nested'));
    const error = await rejected(loadMigrationFiles(dir));
    expect((error as MigrateError).message).toContain('nested');
  });

  it('refuses a missing folder', async () => {
    const error = await rejected(loadMigrationFiles(join(migrationsDir({}), 'absent')));
    expect(error).toBeInstanceOf(MigrateError);
  });

  it('refuses two files with the same timestamp', async () => {
    const dir = migrationsDir({
      '1760000000001_a.sql': migrationText('select 1;', 'select 1;'),
      '1760000000001_b.sql': migrationText('select 2;', 'select 2;'),
    });
    const error = await rejected(loadMigrationFiles(dir));
    expect((error as MigrateError).message).toContain('1760000000001');
  });
});
