import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createParseClient } from '../src/client.ts';
import type { ParseClientRequest } from '../src/client.ts';
import { CLIENT, HOST_TOKEN_SHA256, isolatedPolicy, ORG_A, PROJECT_A } from './helpers.ts';

const TIMEOUT_MS = 60_000;
const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, '../../..');
const main = resolve(here, '../src/supervisor-main.ts');
const fixture = resolve(here, 'fixtures/hosts/fixture-supervisor.ts');

const running: ChildProcess[] = [];
afterEach(() => {
  for (const child of running.splice(0)) child.kill('SIGKILL');
});

interface Line {
  readonly event?: string;
  readonly level?: string;
  readonly pid?: number;
  readonly port?: number;
  readonly signal?: string;
}

// Reads the JSON lines of a child and lets a test wait for the next one that matches.
function watch(child: ChildProcess) {
  const lines: Line[] = [];
  let pending = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    pending += chunk.toString();
    const parts = pending.split('\n');
    pending = parts.pop() ?? '';
    for (const part of parts) if (part !== '') lines.push(JSON.parse(part) as Line);
  });
  let from = 0;
  const next = async (event: string) => {
    let found: Line | undefined;
    await expect
      .poll(
        () => {
          const index = lines.findIndex((line, at) => at >= from && line.event === event);
          if (index === -1) return false;
          from = index + 1;
          found = lines[index];
          return true;
        },
        { timeout: TIMEOUT_MS / 2, interval: 20 },
      )
      .toBe(true);
    return found as Line;
  };
  return { lines, next };
}

function start(env: NodeJS.ProcessEnv = {}, args: readonly string[] = [main]) {
  const flags = args[0] === main ? [`--allow-fs-read=${workspace}`, '--allow-child-process'] : [];
  const child = spawn(
    process.execPath,
    [...(flags.length > 0 ? ['--permission', ...flags] : []), ...args],
    {
      env: { DREFYN_PARSE_TOKEN_SHA256: HOST_TOKEN_SHA256, DREFYN_PARSE_PORT: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  running.push(child);
  return { child, ...watch(child) };
}

const ended = (child: ChildProcess) =>
  new Promise<number | string | null>((done) => {
    if (child.exitCode !== null || child.signalCode !== null) done(child.exitCode);
    else
      child.once('exit', (code, signal) => {
        done(signal ?? code);
      });
  });

const page: ParseClientRequest = {
  tenant: { organizationId: ORG_A, projectId: PROJECT_A },
  path: 'docs/page.md',
  source: '# One\n',
  dialect: 'md',
  policy: isolatedPolicy(),
};

const clientOn = ({ port }: Line) =>
  createParseClient({ ...CLIENT, url: `http://127.0.0.1:${String(port ?? 0)}` });

describe('the supervised host', () => {
  it(
    'comes back after a SIGKILL, and serves again',
    async () => {
      const { next } = start();
      const { pid } = await next('mdx.parse_host_started');
      const first = await next('mdx.parse_host_listening');
      await expect(clientOn(first).parse(page)).resolves.toMatchObject({ ok: true });

      process.kill(pid ?? 0, 'SIGKILL');
      await expect(next('mdx.parse_host_crashed')).resolves.toMatchObject({ signal: 'SIGKILL' });
      const second = await next('mdx.parse_host_listening');
      await expect(clientOn(second).parse(page)).resolves.toMatchObject({ ok: true });
    },
    TIMEOUT_MS,
  );

  it(
    'alerts on a crash loop, stays down through the cool off, then tries again',
    async () => {
      const { next } = start({
        DREFYN_PARSE_RESTART_BACKOFF_MS: '10',
        DREFYN_PARSE_CRASH_LIMIT: '2',
        DREFYN_PARSE_COOL_OFF_MS: '1500',
      });
      const killNext = async () => {
        const { pid } = await next('mdx.parse_host_started');
        const listening = await next('mdx.parse_host_listening');
        process.kill(pid ?? 0, 'SIGKILL');
        return listening;
      };
      await killNext();
      await next('mdx.parse_host_crashed');
      const last = await killNext();
      await expect(next('mdx.parse_host_crash_loop')).resolves.toMatchObject({
        level: 'error',
        signal: 'SIGKILL',
      });
      await expect(clientOn(last).parse(page)).resolves.toMatchObject({
        error: [{ code: 'mdx.parse_unavailable' }],
      });
      const back = await next('mdx.parse_host_listening');
      await expect(clientOn(back).parse(page)).resolves.toMatchObject({ ok: true });
    },
    TIMEOUT_MS,
  );

  it(
    'takes a native stall from the pool to SIGKILL to a new host',
    async () => {
      const { next } = start({}, [fixture, 'native-stall']);
      const first = await next('mdx.parse_host_listening');
      await expect(clientOn(first).parse(page)).resolves.toMatchObject({
        error: [{ code: 'mdx.parse_unavailable' }],
      });
      await expect(next('mdx.parse_host_crashed')).resolves.toMatchObject({ signal: 'SIGKILL' });
      const second = await next('mdx.parse_host_listening');
      expect((await fetch(`http://127.0.0.1:${String(second.port)}/health`)).status).toBe(200);
    },
    TIMEOUT_MS,
  );

  it(
    'stops with the host on SIGTERM and exits clean',
    async () => {
      const { child, next } = start();
      await next('mdx.parse_host_listening');
      child.kill('SIGTERM');
      await expect(ended(child)).resolves.toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    'refuses at once, not by a crash loop, on what can never work',
    async () => {
      const { child, lines } = start({ DREFYN_PARSE_TOKEN_SHA256: 'nope' });
      expect(await ended(child)).not.toBe(0);
      expect(lines).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    'refuses a credential in its environment, by name',
    async () => {
      const { child } = start({ DATABASE_URL: 'postgres://x' });
      expect(await ended(child)).not.toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    'refuses to run without --permission',
    async () => {
      const child = spawn(process.execPath, [main], {
        env: { DREFYN_PARSE_TOKEN_SHA256: HOST_TOKEN_SHA256 },
        stdio: 'ignore',
      });
      running.push(child);
      expect(await ended(child)).not.toBe(0);
    },
    TIMEOUT_MS,
  );
});
