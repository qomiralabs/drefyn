import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './helpers.ts';

// Merges coverage blobs and runs no test. The other two render or time one thing at a time,
// by hand, and neither is part of a gate.
const NO_TESTS = new Set([
  'packages/db/vitest.merged.config.ts',
  'packages/email/vitest.tools.config.ts',
  'packages/site/bench/vitest.config.ts',
]);
const FIXTURE = /(^|\/)test\/fixtures\//;

const configs = execFileSync('git', ['ls-files', '-z', '*vitest*config.ts'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split('\0')
  .filter((file) => file !== '' && !NO_TESTS.has(file) && !FIXTURE.test(file));

describe('every vitest config', () => {
  it('finds the configs it is about', () => {
    expect(configs.length).toBeGreaterThan(20);
  });

  // A run with no watchdog is how a sync loop ends up holding a core for hours.
  it.each(configs)('%s runs under the watchdog', (file) => {
    const text = readFileSync(join(repoRoot, file), 'utf8');
    expect(text).toMatch(/sharedConfig|watchdogSetup|@drefyn\/test-watchdog\/setup/);
    expect(text).toMatch(/sharedConfig|watchdogGlobalSetup|@drefyn\/test-watchdog\/global-setup/);
  });
});
