import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../src/', import.meta.url).pathname;
const SCANNED = ['app', 'shell', 'views', 'server'];
const IMPORTS_FIXTURE = /from '[^']*\/fixtures\/[^']*'|import\('[^']*\/fixtures\//;
const STATES_SWITCH = "process.env['DREFYN_DASHBOARD_STATES'] !== 'on'";

// Each of these answers 404 unless a server opted in to the test states.
const GATED = [
  'app/settings-states/[screen]/[state]/page.tsx',
  'app/shell-states/[product]/[project]/[[...section]]/page.tsx',
  'server/pages-actions.ts',
  'server/pages-fixture.ts',
];

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });

const scanned = SCANNED.flatMap((dir) => filesUnder(join(SRC, dir))).filter((path) =>
  /\.tsx?$/.test(path),
);
const withFixtures = scanned
  .filter((path) => IMPORTS_FIXTURE.test(readFileSync(path, 'utf8')))
  .map((path) => relative(SRC, path));

describe('shipping code', () => {
  it('finds the source tree', () => {
    expect(scanned.length).toBeGreaterThan(50);
  });

  it('imports no fixture outside the gated test states', () => {
    expect(withFixtures.filter((path) => !GATED.includes(path))).toEqual([]);
  });

  it.each(GATED.filter((path) => path.endsWith('page.tsx') || path.endsWith('actions.ts')))(
    '%s answers only on a server that opted in',
    (path) => {
      expect(readFileSync(join(SRC, path), 'utf8')).toContain(STATES_SWITCH);
    },
  );
});
