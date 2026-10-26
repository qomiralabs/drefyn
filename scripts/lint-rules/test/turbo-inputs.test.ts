import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './helpers.ts';

// These tests read files from all over the repository (every package manifest, the
// review gate rules, CODEOWNERS, the template), so a cache key built from this package
// alone replays a stale pass after any of them changes.
const ROOT = '$TURBO_ROOT$/';

const task = (
  JSON.parse(readFileSync(join(repoRoot, 'turbo.json'), 'utf8')) as {
    tasks: Record<string, { inputs?: string[] } | undefined>;
  }
).tasks['@drefyn/lint-rules#test'];

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\0')
  .filter((file) => file !== '');

describe('the lint-rules test cache key', () => {
  it('hashes the whole repository root', () => {
    expect(task?.inputs).toEqual(expect.arrayContaining(['$TURBO_DEFAULT$', `${ROOT}**`]));
  });

  it('only excludes paths that hold no tracked file', () => {
    const excluded = (task?.inputs ?? [])
      .filter((input) => input.startsWith(`!${ROOT}`))
      .map((input) => input.slice(ROOT.length + 1));
    expect(excluded.length).toBeGreaterThan(0);
    const dropped = tracked.filter((file) => excluded.some((glob) => matchesGlob(file, glob)));
    expect(dropped).toEqual([]);
  });

  it('covers the files these tests are known to read from outside the package', () => {
    for (const file of [
      'scripts/review-gate/rules.json',
      '.github/CODEOWNERS',
      'templates/package/package.json',
      'eslint.config.js',
    ]) {
      expect(tracked, file).toContain(file);
    }
  });
});
