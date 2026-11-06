import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serialize } from '../src/serialize.ts';
import { createParsePool } from '../src/pool.ts';
import type { ParsePool } from '../src/pool.ts';
import type { ParsePoolConfig } from '../src/pool-config.ts';
import { startParseThread } from '../src/thread.ts';
import {
  isolatedPolicy,
  ORG_A,
  poolConfig,
  PROJECT_A,
  PROJECT_B,
  recordingLogger,
} from './helpers.ts';

const LONG = poolConfig({ timeoutMs: 20_000 });
const SHORT = poolConfig({ timeoutMs: 500 });
// Workers start slowly on a loaded runner, so the proof is that the promise settles at all.
const TIMEOUT_MS = 60_000;
const worker = (name: string) => new URL(`./fixtures/workers/${name}.ts`, import.meta.url);

const pools: ParsePool[] = [];
const logger = recordingLogger();
const onStuck = vi.fn();
const open = (config: ParsePoolConfig = LONG, fixture?: string) => {
  const script = fixture === undefined ? undefined : worker(fixture);
  const pool = createParsePool(config, {
    logger,
    onStuck,
    ...(script && { startThread: () => startParseThread(script, config) }),
  });
  pools.push(pool);
  return pool;
};

const page = (source: string, dialect: 'md' | 'mdx' = 'mdx', projectId = PROJECT_A) => ({
  tenant: { organizationId: ORG_A, projectId },
  path: 'docs/page.mdx',
  source,
  dialect,
  policy: isolatedPolicy(['Note']),
});

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  logger.entries.length = 0;
});

describe('the parse pool', () => {
  it(
    'gives the same answer as the direct parse',
    async () => {
      const source = '# One\n\n<Note a="1" />\n';
      const result = await open().parse(page(source));
      if (!result.ok) throw new Error('refused');
      expect(result.value.issues).toEqual([]);
      expect(serialize(result.value.ast)).toBe(source);
    },
    TIMEOUT_MS,
  );

  it(
    'passes a refusal through',
    async () => {
      const result = await open().parse(page('<Open>\n'));
      expect(result).toMatchObject({ ok: false, error: [{ code: 'mdx.parse_failed', line: 1 }] });
    },
    TIMEOUT_MS,
  );

  it(
    'reuses a thread between pages',
    async () => {
      const pool = open();
      await pool.parse(page('one\n'));
      await pool.parse(page('two\n'));
      expect(pool.stats().threads).toBe(1);
    },
    TIMEOUT_MS,
  );
});

describe('the kill path', () => {
  it(
    'ends a stall inside a regular expression and replaces the thread',
    async () => {
      const pool = open(SHORT, 'stall-regex');
      await expect(pool.parse(page('a'))).resolves.toEqual({
        ok: false,
        error: [{ code: 'mdx.parse_timeout', severity: 'error', line: 1, column: 1 }],
      });
      expect(pool.stats()).toMatchObject({ threads: 0, busy: 0 });
      await expect(pool.parse(page('a'))).resolves.toMatchObject({
        error: [{ code: 'mdx.parse_timeout' }],
      });
    },
    TIMEOUT_MS,
  );

  it(
    'ends a thread that runs out of its heap, and the process lives',
    async () => {
      const pool = open(poolConfig({ timeoutMs: 45_000, maxMemoryMb: 32 }), 'allocate');
      await expect(pool.parse(page('a'))).resolves.toEqual({
        ok: false,
        error: [{ code: 'mdx.out_of_memory', severity: 'error', line: 1, column: 1 }],
      });
      expect(pool.stats().threads).toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    'turns a crash into a refusal with no message in it',
    async () => {
      const result = await open(LONG, 'crash').parse(page('CANARY-PAGE-TEXT'));
      expect(result).toEqual({
        ok: false,
        error: [{ code: 'mdx.parse_failed', severity: 'error', line: 1, column: 1 }],
      });
      expect(JSON.stringify(logger.entries)).not.toContain('CANARY-PAGE-TEXT');
    },
    TIMEOUT_MS,
  );

  it(
    'says the pool failed and not the page when a thread cannot load',
    async () => {
      await expect(open(LONG, 'crash-on-load').parse(page('a'))).resolves.toMatchObject({
        error: [{ code: 'mdx.parse_unavailable' }],
      });
    },
    TIMEOUT_MS,
  );

  it(
    'gives up on a thread that never comes up',
    async () => {
      const config = { ...SHORT, startTimeoutMs: 300 };
      const pool = open(config, 'never-ready');
      await expect(pool.parse(page('a'))).resolves.toMatchObject({
        error: [{ code: 'mdx.parse_unavailable' }],
      });
      expect(pool.stats().threads).toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    'kills a thread whose answer is for some other job',
    async () => {
      const pool = open(LONG, 'wrong-id');
      await expect(pool.parse(page('a'))).resolves.toMatchObject({
        error: [{ code: 'mdx.parse_failed' }],
      });
      expect(pool.stats().threads).toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    'kills a thread whose answer has the wrong shape',
    async () => {
      const pool = open(LONG, 'wrong-id');
      await expect(pool.parse(page('malformed'))).resolves.toMatchObject({
        error: [{ code: 'mdx.parse_failed' }],
      });
      expect(pool.stats().threads).toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    'reports a stall terminate cannot end, inside native code',
    async () => {
      const pool = open(poolConfig({ timeoutMs: 200, killGraceMs: 300 }), 'native-stall');
      await pool.parse(page('a'));
      expect(onStuck).toHaveBeenCalledOnce();
    },
    TIMEOUT_MS,
  );

  it(
    'does not let thread output reach the process streams',
    async () => {
      const stderr = vi.spyOn(process.stderr, 'write');
      const stdout = vi.spyOn(process.stdout, 'write');
      await open(LONG, 'chatty').parse(page('CANARY-PAGE-TEXT'));
      const written = [...stderr.mock.calls, ...stdout.mock.calls].flat().map(String).join('');
      expect(written).not.toContain('CANARY-PAGE-TEXT');
    },
    TIMEOUT_MS,
  );
});

describe('what a thread can reach', () => {
  it(
    'has no credentials and no network',
    async () => {
      process.env['DREFYN_TEST_SECRET'] = 'must-not-cross';
      const sockets: Socket[] = [];
      const server = createServer((socket) => sockets.push(socket));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      try {
        const result = await open(LONG, 'probe').parse(page(String(address.port)));
        if (!result.ok) throw new Error('refused');
        expect(result.value).toEqual({
          issues: [],
          env: [],
          argv: [],
          net: 'refused',
          tls: 'refused',
          http: 'refused',
          listen: 'refused',
          fetch: 'refused',
          udp: 'refused',
          lookup: 'refused',
          resolve: 'refused',
          binding: 'refused',
          child: 'refused',
          spawnSync: 'refused',
          execSync: 'refused',
          execFileSync: 'refused',
          worker: 'refused',
          inspector: 'refused',
          kill: 'refused',
        });
        expect(sockets).toEqual([]);
      } finally {
        delete process.env['DREFYN_TEST_SECRET'];
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
      }
    },
    TIMEOUT_MS,
  );
});

describe('tenant separation on a shared thread', () => {
  it(
    'gives each project only its own page',
    async () => {
      const pool = open();
      const [one, two] = await Promise.all([
        pool.parse(page('alpha\n', 'md', PROJECT_A)),
        pool.parse(page('beta\n', 'md', PROJECT_B)),
      ]);
      expect(one.ok && serialize(one.value.ast)).toBe('alpha\n');
      expect(two.ok && serialize(two.value.ast)).toBe('beta\n');
    },
    TIMEOUT_MS,
  );
});
