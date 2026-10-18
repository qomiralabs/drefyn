import { readFileSync, readdirSync } from 'node:fs';
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
      expect(sql, name).not.toMatch(/\bpassword\b/);
      expect(sql, name).not.toMatch(/\bbypassrls\b/);
    }
  });
});
