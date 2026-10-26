import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import {
  describeFailure,
  fixtureMigrations,
  migrate,
  migration,
  recordedName,
} from './support/cli.ts';
import { databases } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { migrationState, tableExists } from './support/sql.ts';

const dbs = databases();
const markers = mkdtempSync(join(tmpdir(), 'drefyn-db-it-marker-'));
afterAll(() => {
  rmSync(markers, { recursive: true, force: true });
});

const WIDGETS = '9000000000001_widgets.sql';
const widgets = migration('create table app.widgets (id int);', 'drop table app.widgets;');

// Runs as CommonJS or ESM; leaves a file behind if anything ever executes it.
const script = (marker: string) =>
  `process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n` +
  'export const up = () => undefined;\n';

describeWithStack('the migrations folder against a real database', () => {
  it('skips a .DS_Store with a warning and applies the rest', async () => {
    const db = await dbs.fresh('base');
    const dir = fixtureMigrations({
      [WIDGETS]: widgets,
      '.DS_Store': '\u0000\u0000\u0000\u0001Bud1',
    });
    const result = await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir });
    expect(result.code, describeFailure(result)).toBe(0);
    expect(result.stderr).toContain('.DS_Store');
    expect(await tableExists(db.owner, 'app.widgets')).toBe(true);
    expect((await migrationState(db.owner))?.applied).toContain(recordedName(WIDGETS));
  });

  // The migration tool would load these through jiti; the wrapper must refuse them unrun.
  it.each(['.js', '.cjs', '.mjs', '.ts', '.mts', '.cts', '.sql.js'])(
    'refuses a %s file named like a migration, never runs it, and applies nothing',
    async (ext) => {
      const db = await dbs.fresh('base');
      const marker = join(markers, `ran${ext}`);
      const stray = `9000000000002_stray${ext}`;
      const dir = fixtureMigrations({ [WIDGETS]: widgets, [stray]: script(marker) });
      const result = await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir });
      expect(result.code, describeFailure(result)).toBe(1);
      expect(result.stderr).toContain(stray);
      expect(existsSync(marker)).toBe(false);
      expect(await migrationState(db.owner)).toBeNull();
      expect(await tableExists(db.owner, 'app.widgets')).toBe(false);
    },
  );

  it('refuses a stray file on status and down as well', async () => {
    const db = await dbs.fresh('migrated');
    const marker = join(markers, 'ran-status-down');
    const dir = fixtureMigrations({ '9000000000002_stray.js': script(marker) });
    const state = await migrationState(db.owner);
    for (const args of [
      ['migrate', 'status'],
      ['migrate', 'down'],
    ]) {
      const result = await migrate(args, { url: db.owner, migrationsDir: dir });
      expect(result.code, describeFailure(result)).toBe(1);
      expect(result.stderr).toContain('9000000000002_stray.js');
    }
    expect(existsSync(marker)).toBe(false);
    expect(await migrationState(db.owner)).toEqual(state);
  });
});
