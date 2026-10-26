import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DbError } from '../src/errors.ts';
import { MIGRATE_OUTCOMES, MigrateError, exitCodeFor, outcomeOf } from '../src/outcome.ts';

const src = join(import.meta.dirname, '..', 'src');

describe('exit codes', () => {
  it.each([
    ['done', 0],
    ['failed', 1],
    ['lock_held', 2],
    ['checksum_mismatch', 3],
    ['prerequisite_missing', 4],
  ] as const)('%s exits %i', (outcome, code) => {
    expect(exitCodeFor(outcome)).toBe(code);
  });

  it('covers every outcome with a distinct code from 0 to 4', () => {
    const codes = MIGRATE_OUTCOMES.map((o) => exitCodeFor(o));
    expect([...codes].sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it('classifies each MigrateError by its outcome', () => {
    for (const outcome of [
      'failed',
      'lock_held',
      'checksum_mismatch',
      'prerequisite_missing',
    ] as const) {
      expect(outcomeOf(new MigrateError(outcome, 'x'))).toBe(outcome);
    }
  });

  it('reads the migration tool lock error as lock held', () => {
    const tool = new Error(
      "Another migration is already running. Advisory lock mode is set to 'fail'.",
    );
    expect(outcomeOf(tool)).toBe('lock_held');
    expect(outcomeOf(new Error('Error loading migration files', { cause: tool }))).toBe(
      'lock_held',
    );
  });

  it('reads everything else as failed', () => {
    expect(outcomeOf(new Error('connect ECONNREFUSED 127.0.0.1:1'))).toBe('failed');
    expect(
      outcomeOf(new DbError('DB_CONFIG_INVALID', 'DREFYN_MIGRATION_DATABASE_URL is missing')),
    ).toBe('failed');
    expect(outcomeOf(new Error('lock_held'))).toBe('failed');
    expect(outcomeOf('a string')).toBe('failed');
    expect(outcomeOf(undefined)).toBe('failed');
    expect(outcomeOf(null)).toBe('failed');
    expect(outcomeOf({ outcome: 'lock_held' })).toBe('failed');
  });

  it('sets the process exit code nowhere but through exitCodeFor', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(src)) {
      const text = readFileSync(join(src, file), 'utf8');
      if (/process\.exit\s*\(/.test(text)) offenders.push(`${file}: process.exit()`);
      if (/exitCode\s*=\s*\d/.test(text)) offenders.push(`${file}: literal exit code`);
    }
    expect(offenders).toEqual([]);
  });
});
