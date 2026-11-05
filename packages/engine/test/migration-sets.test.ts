import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NODE_FAMILIES, NODE_LIFECYCLES, ORIGINS } from '../src/index.ts';

const migrations = join(import.meta.dirname, '..', '..', 'db', 'migrations');
const file = readdirSync(migrations).find((name) => name.endsWith('_engine_tables.sql'));
if (file === undefined) throw new Error('no engine tables migration');
const up = readFileSync(join(migrations, file), 'utf8').split('-- Down Migration')[0] ?? '';

// Every check on the column, as its quoted values in order.
function checksOn(column: string): readonly (readonly string[])[] {
  const checks = up.matchAll(new RegExp(`check \\(${column} in \\(([^)]*)\\)\\)`, 'g'));
  return [...checks].map((check) =>
    [...(check[1] ?? '').matchAll(/'([^']*)'/g)].map((value) => value[1] ?? ''),
  );
}

// The package cannot import the database and the database cannot import the package, so the
// migration text is the only place both lists can be compared.
describe('the engine tables migration', () => {
  it('checks family against the code on content types and nodes', () => {
    expect(checksOn('family')).toEqual([NODE_FAMILIES, NODE_FAMILIES]);
  });

  it('checks lifecycle against the code', () => {
    expect(checksOn('lifecycle')).toEqual([NODE_LIFECYCLES]);
  });

  it('checks origin against the code', () => {
    expect(checksOn('origin')).toEqual([ORIGINS]);
  });
});
