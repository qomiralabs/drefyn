import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { descendants, stillRunning, sweep } from '@drefyn/test-watchdog/tree';
import type { Seen } from '@drefyn/test-watchdog/tree';
import { afterEach, describe, expect, it } from 'vitest';
import { PARENT_GONE_EXIT_CODE } from '../src/parent-watch.ts';
import { HOST_TOKEN_SHA256 } from './helpers.ts';

const TIMEOUT_MS = 60_000;
// The hold, one check, the grace, and a loaded machine. A bound for failure, not a timing.
const GONE_WITHIN_MS = 30_000;
const here = import.meta.dirname;
const workspace = resolve(here, '../../..');
const parentFixture = resolve(here, 'fixtures/hosts/fixture-parent.ts');
const hold = `--import=${pathToFileURL(resolve(here, 'fixtures/hosts/hold-load.ts')).href}`;
const read = `--allow-fs-read=${workspace}`;
const HOST = ['--permission', read, '--allow-worker', hold, resolve(here, '../src/host-main.ts')];
const SUPERVISOR = [
  '--permission',
  read,
  '--allow-child-process',
  hold,
  resolve(here, '../src/supervisor-main.ts'),
];

const started: ChildProcess[] = [];
let tree: Seen[] = [];
afterEach(() => {
  sweep(tree);
  tree = [];
  for (const child of started.splice(0)) child.kill('SIGKILL');
});

// Hosts a supervisor starts after the parent is gone are not under the parent, so they are
// found by the pid the supervisor logs.
function hostsIn(output: string): Seen[] {
  const pids = [...output.matchAll(/"event":"mdx\.parse_host_started","pid":(\d+)/g)];
  return pids.flatMap(([, pid]) => descendants(1).filter((seen) => seen.pid === Number(pid)));
}

describe.each([
  ['the host', HOST],
  ['the supervisor', SUPERVISOR],
])('%s', (_, args) => {
  it(
    'exits when its parent dies while its slow imports are still loading',
    async () => {
      const parent = spawn(process.execPath, [parentFixture, process.execPath, ...args], {
        env: { DREFYN_PARSE_TOKEN_SHA256: HOST_TOKEN_SHA256, DREFYN_PARSE_PORT: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      started.push(parent);
      let output = '';
      let errors = '';
      parent.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
      parent.stderr.on('data', (chunk: Buffer) => (errors += chunk.toString()));

      await expect
        .poll(() => errors, { timeout: TIMEOUT_MS / 2, interval: 20 })
        .toContain('hold-load: holding');
      tree = [...descendants(parent.pid ?? 0)];
      expect(tree).toHaveLength(1);

      parent.kill('SIGKILL');
      await expect
        .poll(
          () => {
            tree = [
              ...tree,
              ...hostsIn(output).filter(({ pid }) => !tree.some((t) => t.pid === pid)),
            ];
            return stillRunning(tree);
          },
          { timeout: GONE_WITHIN_MS, interval: 50 },
        )
        .toEqual([]);
      // Read from a pipe, so the last lines can land after the process is gone.
      await expect
        .poll(() => errors, { timeout: TIMEOUT_MS / 2, interval: 20 })
        .toContain(`hold-load: exit ${String(PARENT_GONE_EXIT_CODE)}`);
      const gone = output
        .split('\n')
        .filter((line) => line.includes('mdx.parse_host_parent_gone'))
        .map((line): unknown => JSON.parse(line));
      expect(gone).toEqual([{ level: 'error', event: 'mdx.parse_host_parent_gone' }]);
    },
    TIMEOUT_MS,
  );
});
