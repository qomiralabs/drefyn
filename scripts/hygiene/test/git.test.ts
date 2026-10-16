import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGit } from '../src/git.ts';

// Far more than any pipe buffer, so the child is gone before the write can finish.
const LARGE_INPUT = 'x'.repeat(8 * 1024 * 1024);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hygiene-git-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runGit', () => {
  it('reports a failing git as an error even when it never read its input', async () => {
    await expect(runGit(dir, ['cat-file', '--no-such-flag'], LARGE_INPUT)).rejects.toThrow(
      /git cat-file failed \(exit 128\)/,
    );
  });

  it('does not treat a successful exit as success when git ignored its input', async () => {
    await expect(runGit(dir, ['--version'], LARGE_INPUT)).rejects.toThrow(
      /git --version closed its input early/,
    );
  });

  it('runs commands that take no input without opening stdin', async () => {
    const out = await runGit(dir, ['--version']);
    expect(out.toString()).toMatch(/^git version/);
  });

  it('rejects when git cannot be started', async () => {
    await expect(runGit(join(dir, 'missing'), ['--version'])).rejects.toThrow(/ENOENT/);
  });
});
