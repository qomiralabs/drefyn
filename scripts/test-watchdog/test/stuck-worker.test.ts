import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { descendants, sweep, stillRunning } from '../src/tree.ts';
import type { Seen } from '../src/tree.ts';

const here = import.meta.dirname;
const fixtures = resolve(here, 'fixtures');
const vitest = resolve(here, '../../../node_modules/vitest/vitest.mjs');

interface Fixture {
  readonly child: ChildProcess;
  readonly output: () => string;
  readonly exit: Promise<number | null>;
}

let scratch: string;
const started: ChildProcess[] = [];
let seen: readonly Seen[] = [];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'test-watchdog-'));
});

// Kills whatever a failed test left. A spin that got away is the bug these tests are about.
afterEach(() => {
  sweep(seen);
  seen = [];
  for (const child of started.splice(0)) {
    if (child.pid !== undefined) sweep(descendants(child.pid));
    child.kill('SIGKILL');
  }
  rmSync(scratch, { recursive: true, force: true });
});

function run(file: string, env: NodeJS.ProcessEnv): Fixture {
  const child = spawn(process.execPath, [vitest, 'run', '--root', fixtures], {
    cwd: fixtures,
    env: {
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      FIXTURE_FILE: file,
      FIXTURE_CACHE: join(scratch, 'cache'),
      FIXTURE_READY: join(scratch, 'ready'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  started.push(child);
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const exit = new Promise<number | null>((done) => {
    child.once('close', done);
  });
  return { child, output: () => output, exit };
}

describe('a worker stuck in sync code', () => {
  it('is ended at the limit and fails the run', async () => {
    const { exit, output } = run('spin.fixture.ts', { DREFYN_TEST_STALL_LIMIT_MS: '2000' });
    await expect(exit).resolves.toBe(1);
    expect(output()).toContain('test watchdog');
    expect(output()).toContain('blocked its event loop');
  });

  it('is ended within seconds when its run is killed, long before the limit', async () => {
    const { child, exit } = run('spin.fixture.ts', { DREFYN_TEST_STALL_LIMIT_MS: '3600000' });
    await expect
      .poll(() => existsSync(join(scratch, 'ready')), { timeout: 30_000, interval: 50 })
      .toBe(true);
    const tree = descendants(child.pid ?? 0);
    seen = tree;
    expect(tree.length).toBeGreaterThan(0);

    child.kill('SIGKILL');
    await exit;
    await expect.poll(() => stillRunning(tree), { timeout: 30_000, interval: 100 }).toEqual([]);
  });
});

describe('a worker that is not stuck', () => {
  it('is left alone past the limit, on real and on fake timers', async () => {
    const { exit, output } = run('patient.fixture.ts', { DREFYN_TEST_STALL_LIMIT_MS: '2000' });
    await expect(exit).resolves.toBe(0);
    expect(output()).not.toContain('test watchdog');
  });
});
