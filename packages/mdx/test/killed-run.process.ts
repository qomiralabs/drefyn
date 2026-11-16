import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { descendants, stillRunning, sweep } from '@drefyn/test-watchdog/tree';
import type { Seen } from '@drefyn/test-watchdog/tree';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST_TOKEN_SHA256 } from './helpers.ts';

const TIMEOUT_MS = 120_000;
const here = import.meta.dirname;
const root = resolve(here, 'fixtures/killed-run');
const vitest = resolve(here, '../../../node_modules/vitest/vitest.mjs');
const wrapper = resolve(here, 'fixtures/hosts/fixture-parent.ts');

let scratch = '';
let left: readonly Seen[] = [];
let run: ChildProcess | undefined;

// A failed test must not leave what it is looking for on the machine.
afterEach(() => {
  sweep(run?.pid === undefined ? left : [...left, ...descendants(run.pid)]);
  run?.kill('SIGKILL');
  run = undefined;
  left = [];
  rmSync(scratch, { recursive: true, force: true });
});

const count = (tree: readonly Seen[], part: string) =>
  tree.filter(({ command }) => command.includes(part)).length;

describe('a test run killed part way', () => {
  it.each([
    ['waiting on its hosts', '0', false],
    ['stuck in sync code', '1', false],
    // A timeout around pnpm kills pnpm, and vitest is only its child.
    ['killed through its wrapper', '0', true],
    ['killed through its wrapper while stuck', '1', true],
  ])(
    'leaves nothing behind when %s',
    async (_, spin, wrapped) => {
      scratch = mkdtempSync(join(tmpdir(), 'killed-run-'));
      const ready = join(scratch, 'ready');
      const command = [vitest, 'run', '--root', root];
      const args = wrapped ? [wrapper, process.execPath, ...command] : command;
      const child = spawn(process.execPath, args, {
        cwd: root,
        env: {
          PATH: process.env['PATH'],
          HOME: process.env['HOME'],
          FIXTURE_CACHE: join(scratch, 'cache'),
          FIXTURE_READY: ready,
          FIXTURE_SPIN: spin,
          FIXTURE_TOKEN_SHA256: HOST_TOKEN_SHA256,
        },
        stdio: 'ignore',
      });
      run = child;
      await expect
        .poll(() => existsSync(ready), { timeout: TIMEOUT_MS / 2, interval: 50 })
        .toBe(true);

      const tree = descendants(child.pid ?? 0);
      left = tree;
      expect({
        hosts: count(tree, 'src/host-main.ts'),
        supervisors: count(tree, 'src/supervisor-main.ts'),
        fixtureHosts: count(tree, 'hosts/fixture-host.ts'),
        fixtureSupervisors: count(tree, 'hosts/fixture-supervisor.ts'),
      }).toEqual({ hosts: 2, supervisors: 1, fixtureHosts: 2, fixtureSupervisors: 1 });

      child.kill('SIGKILL');
      await expect.poll(() => stillRunning(tree), { timeout: 30_000, interval: 100 }).toEqual([]);
    },
    TIMEOUT_MS,
  );
});
