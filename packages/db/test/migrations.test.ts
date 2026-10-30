import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultMigrationsDir } from '../src/constants.ts';
import { loadMigrationFiles } from '../src/migration-file.ts';

// Statement level SQL with comments removed, so a comment that mentions a word is fine.
function sqlOf(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .toLowerCase();
}

describe('shipped migrations', () => {
  it('has at least the first migration, and every file parses with both sections', async () => {
    const files = await loadMigrationFiles(defaultMigrationsDir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.up.length, file.name).toBeGreaterThan(0);
      expect(file.down.length, file.name).toBeGreaterThan(0);
    }
  });

  // The migration role owns neither the extension nor its schema, so such a statement would
  // fail on every database; catching it here keeps it out of a release.
  it('never creates, changes or drops an extension or anything in schema extensions', () => {
    const names = readdirSync(defaultMigrationsDir);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const sql = sqlOf(readFileSync(join(defaultMigrationsDir, name), 'utf8'));
      expect(sql, name).not.toMatch(/\b(create|alter|drop)\s+extension\b/);
      expect(sql, name).not.toMatch(/\bcomment\s+on\s+extension\b/);
      expect(sql, name).not.toMatch(/\bschema\s+"?extensions"?/);
      expect(sql, name).not.toMatch(/\bset\s+schema\s+"?extensions"?/);
      expect(sql, name).not.toMatch(/"?extensions"?\s*\.\s*"?[a-z_]/);
    }
  });

  it('never defines security definer functions or touches roles', () => {
    for (const name of readdirSync(defaultMigrationsDir)) {
      const sql = sqlOf(readFileSync(join(defaultMigrationsDir, name), 'utf8'));
      expect(sql, name).not.toMatch(/\bsecurity\s+definer\b/);
      expect(sql, name).not.toMatch(/\b(create|alter|drop)\s+role\b/);
      // A role password would be a keyword; 'password' as a sign in method is data.
      expect(sql.replace(/'(?:[^']|'')*'/g, "''"), name).not.toMatch(/\bpassword\b/);
      expect(sql, name).not.toMatch(/\bbypassrls\b/);
    }
  });
});

// This folder is the one path the migration tool reads in production, and anything it does
// not ignore it may run as code. Only strictly named, regular .sql files belong in it.
describe('the shipped migrations folder', () => {
  const STRICT_NAME = /^[0-9]{13}_[a-z0-9]+(_[a-z0-9]+)*\.sql$/;
  // Dot files are skipped by the loader; a laptop's .DS_Store is not part of the release.
  const entries = () => readdirSync(defaultMigrationsDir).filter((name) => !name.startsWith('.'));

  it('holds only regular files with strict migration names', () => {
    expect(entries().length).toBeGreaterThan(0);
    for (const name of entries()) {
      expect(name).toMatch(STRICT_NAME);
      const stat = lstatSync(join(defaultMigrationsDir, name));
      expect(stat.isFile() && !stat.isSymbolicLink(), name).toBe(true);
    }
  });

  it('gives every file its own 13 digit prefix', () => {
    const prefixes = entries().map((name) => name.slice(0, 13));
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('loads exactly the files on disk, in name order', async () => {
    const files = await loadMigrationFiles(defaultMigrationsDir, { warn: () => undefined });
    expect(files.map((f) => f.name)).toEqual([...entries()].sort());
  });
});
