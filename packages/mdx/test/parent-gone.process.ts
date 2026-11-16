import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { descendants, stillRunning, sweep } from '@drefyn/test-watchdog/tree';
import type { Seen } from '@drefyn/test-watchdog/tree';
import { afterEach, describe, expect, it } from 'vitest';
import { createParseClient } from '../src/client.ts';
import { CLIENT, HOST_TOKEN_SHA256, isolatedPolicy, ORG_A, PROJECT_A } from './helpers.ts';

const TIMEOUT_MS = 60_000;
// One check, the grace, and a loaded machine.
const GONE_WITHIN_MS = 30_000;
const here = import.meta.dirname;
const workspace = resolve(here, '../../..');
const hostMain = resolve(here, '../src/host-main.ts');
const supervisorMain = resolve(here, '../src/supervisor-main.ts');
const parentFixture = resolve(here, 'fixtures/hosts/fixture-parent.ts');
// The flags the image and the supervisor use, and no others.
const HOST = ['--permission', `--allow-fs-read=${workspace}`, '--allow-worker', hostMain];
const SUPERVISOR = [
  '--permission',
  `--allow-fs-read=${workspace}`,
  '--allow-child-process',
  supervisorMain,
];

const started: ChildProcess[] = [];
let tree: readonly Seen[] = [];
afterEach(() => {
  sweep(tree);
  tree = [];
  for (const child of started.splice(0)) child.kill('SIGKILL');
});

function underParent(args: readonly string[]) {
  const parent = spawn(process.execPath, [parentFixture, process.execPath, ...args], {
    env: { DREFYN_PARSE_TOKEN_SHA256: HOST_TOKEN_SHA256, DREFYN_PARSE_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  started.push(parent);
  let output = '';
  parent.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const port = async () => {
    await expect
      .poll(() => /"port":(\d+)/.test(output), { timeout: TIMEOUT_MS / 2, interval: 20 })
      .toBe(true);
    return /"port":(\d+)/.exec(output)?.[1] ?? '';
  };
  return { parent, port, output: () => output };
}

const page = {
  tenant: { organizationId: ORG_A, projectId: PROJECT_A },
  path: 'docs/page.md',
  source: '# One\n',
  dialect: 'md' as const,
  policy: isolatedPolicy(),
};

describe.each([
  ['the host', HOST, 1],
  ['the supervisor and its host', SUPERVISOR, 2],
])('%s', (_, args, size) => {
  it(
    'exits on its own, under its real flags, once its parent is killed',
    async () => {
      const { parent, port, output } = underParent(args);
      await port();
      tree = descendants(parent.pid ?? 0);
      expect(tree).toHaveLength(size);

      parent.kill('SIGKILL');
      await expect
        .poll(() => stillRunning(tree), { timeout: GONE_WITHIN_MS, interval: 50 })
        .toEqual([]);
      // Read from a pipe, so the last line can land after the process is gone.
      await expect
        .poll(output, { timeout: TIMEOUT_MS / 2, interval: 20 })
        .toContain('mdx.parse_host_parent_gone');
    },
    TIMEOUT_MS,
  );

  it(
    'keeps serving under a live parent, well past the check',
    async () => {
      const { parent, port, output } = underParent(args);
      const client = createParseClient({ ...CLIENT, url: `http://127.0.0.1:${await port()}` });
      tree = descendants(parent.pid ?? 0);
      const from = performance.now();
      await expect
        .poll(
          async () => {
            await expect(client.parse(page)).resolves.toMatchObject({ ok: true });
            return performance.now() - from;
          },
          { timeout: TIMEOUT_MS / 2, interval: 100 },
        )
        .toBeGreaterThan(3_000);
      expect(stillRunning(tree)).toHaveLength(size);
      expect(output()).not.toContain('mdx.parse_host_parent_gone');
    },
    TIMEOUT_MS,
  );
});
