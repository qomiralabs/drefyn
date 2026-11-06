import type { MdxRoot } from '../src/index.ts';
import { honestPage } from './honest-page.ts';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createParseClient } from '../src/client.ts';
import type { ParseClientRequest } from '../src/client.ts';
import { assertHostEnv, parseHostConfig } from '../src/host-config.ts';
import { DEFAULT_LIMITS } from '../src/index.ts';
import { serialize } from '../src/serialize.ts';
import { isolatedPolicy, ORG_A, PROJECT_A } from './helpers.ts';

const TIMEOUT_MS = 60_000;
// A parse and a print of the largest page, each several seconds on a busy CI runner.
const FULL_PAGE_TIMEOUT_MS = 180_000;
const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, '../../..');
const hostMain = resolve(here, '../src/host-main.ts');
const fixtureHost = resolve(here, 'fixtures/hosts/fixture-host.ts');
const PERMISSION = ['--permission', `--allow-fs-read=${workspace}`, '--allow-worker'];

const hosts: ChildProcess[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.kill('SIGKILL');
});

const ended = (host: ChildProcess) =>
  new Promise<NodeJS.Signals | number | null>((resolve) => {
    if (host.exitCode !== null || host.signalCode !== null) {
      resolve(host.signalCode ?? host.exitCode);
    } else
      host.once('exit', (code, signal) => {
        resolve(signal ?? code);
      });
  });

// The host prints one line with its port, so a test never guesses at one.
function start(args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  const host = spawn(process.execPath, [...PERMISSION, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  hosts.push(host);
  const url = new Promise<string>((resolve, reject) => {
    let text = '';
    host.stdout.on('data', (chunk: Buffer) => {
      text += chunk.toString();
      const port = /"port":(\d+)/.exec(text)?.[1];
      if (port !== undefined) resolve(`http://127.0.0.1:${port}`);
    });
    host.once('exit', () => {
      reject(new Error('the host stopped before it listened'));
    });
  });
  return { host, url };
}

const page = (source: string): ParseClientRequest => ({
  tenant: { organizationId: ORG_A, projectId: PROJECT_A },
  path: 'docs/page.md',
  source,
  dialect: 'md',
  policy: isolatedPolicy(),
});

describe('the parse host', () => {
  it(
    'parses for a client across the wire, under --permission',
    async () => {
      const { url } = start([hostMain], { DREFYN_PARSE_PORT: '0' });
      const client = createParseClient({ url: await url });
      const source = '# One\n\nA page.\n';
      const result = await client.parse(page(source));
      if (!result.ok) throw new Error('refused');
      expect(serialize(result.value.ast)).toBe(source);
    },
    TIMEOUT_MS,
  );

  it(
    'prints for a client across the wire, and hands back the parser tree',
    async () => {
      const { url } = start([hostMain], { DREFYN_PARSE_PORT: '0' });
      const client = createParseClient({ url: await url });
      const parsed = await client.parse(page('old\n'));
      if (!parsed.ok) throw new Error('refused');
      const { ast } = parsed.value;
      const edited = {
        ...ast,
        children: ast.children.map((block) => ({
          ...block,
          children: [{ type: 'text', value: 'new' }],
        })),
      } as unknown as MdxRoot;
      const { tenant, path, policy } = page('');
      const result = await client.print({ tenant, path, policy, root: edited });
      expect(result).toMatchObject({ ok: true, value: { text: 'new\n' } });
      if (!result.ok) throw new Error('refused');
      expect(result.value.ast.children[0]?.source?.raw).toBe('new');
      expect(result.value.timing?.printMs).toBeGreaterThanOrEqual(0);
      expect(result.value.timing?.reparseMs).toBeGreaterThan(0);
      expect(result.value.timing?.threadMs).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  it(
    'carries an honest page at the size limit across the wire',
    async () => {
      // A long kill: this is about the caps and held bytes. Time is proved on the thread.
      const { url } = start([hostMain], {
        DREFYN_PARSE_PORT: '0',
        DREFYN_PARSE_TIMEOUT_MS: '20000',
        DREFYN_PARSE_PRINT_TIMEOUT_MS: '20000',
      });
      const client = createParseClient({ url: await url });
      const source = honestPage('md');
      const first = await client.parse(page(source));
      if (!first.ok) throw new Error('refused');
      const { tenant, path, policy } = page('');
      const result = await client.print({ tenant, path, policy, root: first.value.ast });
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) throw new Error('refused');
      expect(result.value.text).toBe(source);
    },
    FULL_PAGE_TIMEOUT_MS,
  );

  it(
    'answers a hostile page with the kill, and the host lives',
    async () => {
      const { url } = start([hostMain], {
        DREFYN_PARSE_PORT: '0',
        DREFYN_PARSE_TIMEOUT_MS: '500',
      });
      const client = createParseClient({ url: await url });
      const bomb = `> a\n${'b\n'.repeat(30_000)}`;
      await expect(client.parse(page(bomb))).resolves.toMatchObject({
        error: [{ code: 'mdx.parse_timeout' }],
      });
      await expect(client.parse(page('fine\n'))).resolves.toMatchObject({ ok: true });
    },
    TIMEOUT_MS,
  );

  it(
    'keeps files, children and addons from a thread, where the seal is only a seatbelt',
    async () => {
      const { url } = start([fixtureHost, 'host-probe']);
      const client = createParseClient({ url: await url });
      const result = await client.parse(page('x'));
      expect(result).toEqual({
        ok: true,
        value: { issues: [], ast: { file: 'ERR_ACCESS_DENIED', env: [] } },
      });
    },
    TIMEOUT_MS,
  );

  it(
    'dies by SIGKILL on a native stall, and the caller gets a retryable refusal',
    async () => {
      // Not under --permission: the stand in for a native stall has to be able to block.
      const host = spawn(process.execPath, [fixtureHost, 'native-stall'], {
        env: {},
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      hosts.push(host);
      const url = await new Promise<string>((resolve) => {
        host.stdout.once('data', (chunk: Buffer) => {
          resolve(`http://127.0.0.1:${/"port":(\d+)/.exec(chunk.toString())?.[1] ?? ''}`);
        });
      });
      const client = createParseClient({ url });
      await expect(client.parse(page('a'))).resolves.toMatchObject({
        error: [{ code: 'mdx.parse_unavailable' }],
      });
      await expect(ended(host)).resolves.toBe('SIGKILL');
      await expect(client.parse(page('a'))).resolves.toMatchObject({
        error: [{ code: 'mdx.parse_unavailable' }],
      });
    },
    TIMEOUT_MS,
  );

  it(
    'refuses to start with a secret in its environment',
    async () => {
      const { host, url } = start([hostMain], {
        DREFYN_PARSE_PORT: '0',
        DATABASE_URL: 'postgres://x',
      });
      await expect(url).rejects.toThrow();
      expect(await ended(host)).not.toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    'refuses to start without --permission',
    async () => {
      const host = spawn(process.execPath, [hostMain], { env: {}, stdio: 'ignore' });
      hosts.push(host);
      expect(await ended(host)).not.toBe(0);
    },
    TIMEOUT_MS,
  );
});

describe('the bytes a host may hold', () => {
  const env = (held: string, memory = '1536') => ({
    DREFYN_PARSE_MAX_HELD_BYTES: held,
    DREFYN_PARSE_HOST_MEMORY_MB: memory,
  });

  it('defaults to 256 MiB, which the default memory limit has room for', () => {
    expect(parseHostConfig({}).maxHeldBytes).toBe(268_435_456);
  });

  it('counts them in the memory check at start', () => {
    expect(() => parseHostConfig(env('536870912'))).toThrow('DREFYN_PARSE_HOST_MEMORY_MB');
    expect(parseHostConfig(env('536870912', '1792')).maxHeldBytes).toBe(536_870_912);
  });

  it('refuses a cap too small to hold one page', () => {
    expect(() => parseHostConfig(env('1'))).toThrow();
    expect(() => parseHostConfig(env('not a number'))).toThrow();
  });
});

describe('the host environment', () => {
  it('allows the keys a container brings and our own', () => {
    expect(() => {
      assertHostEnv({ PATH: '/bin', HOME: '/', NODE_VERSION: '24', DREFYN_PARSE_THREADS: '2' });
    }).not.toThrow();
  });

  it.each(['DATABASE_URL', 'DREFYN_AUTH_SECRET', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY'])(
    'refuses %s and does not print its value',
    (key) => {
      expect(() => {
        assertHostEnv({ [key]: 'value-that-must-not-print' });
      }).toThrow(key);
      expect(() => {
        assertHostEnv({ [key]: 'value-that-must-not-print' });
      }).not.toThrow('value-that-must-not-print');
    },
  );

  it('checks the memory floor at start', () => {
    expect(parseHostConfig({}).hostMemoryMb).toBe(1_536);
    expect(() => parseHostConfig({ DREFYN_PARSE_HOST_MEMORY_MB: '1535' })).toThrow();
    expect(() => parseHostConfig({ DREFYN_PARSE_PORT: '70000' })).toThrow();
  });
});

describe('the client', () => {
  const answering = (status: number, body: string) => () =>
    Promise.resolve(new Response(body, { status }));

  it('refuses an oversized page without a call', async () => {
    const client = createParseClient({
      url: 'http://parse.internal',
      fetch: () => Promise.reject(new Error('must not be called')),
    });
    const over = {
      ...page('a'.repeat(5)),
      policy: { ...isolatedPolicy(), limits: { ...DEFAULT_LIMITS, maxBytes: 4 } },
    };
    await expect(client.parse(over)).resolves.toMatchObject({ error: [{ code: 'mdx.too_large' }] });
  });

  const root = { type: 'root', children: [] } as unknown as MdxRoot;
  const printRequest = (overrides = {}) => ({
    tenant: page('').tenant,
    path: 'docs/page.mdx',
    root,
    policy: isolatedPolicy(),
    ...overrides,
  });

  it('refuses an oversized tree without a call', async () => {
    const client = createParseClient({
      url: 'http://parse.internal',
      fetch: () => Promise.reject(new Error('must not be called')),
    });
    const policy = { ...isolatedPolicy(), limits: { ...DEFAULT_LIMITS, maxBytes: 1 } };
    await expect(client.print(printRequest({ policy }))).resolves.toMatchObject({
      error: [{ code: 'mdx.too_large' }],
    });
  });

  it('refuses a tree too deep to send, without a call', async () => {
    const client = createParseClient({
      url: 'http://parse.internal',
      fetch: () => Promise.reject(new Error('must not be called')),
    });
    let deep: unknown = {};
    for (let depth = 0; depth < 200_000; depth += 1) deep = { deep };
    await expect(client.print(printRequest({ root: deep }))).resolves.toMatchObject({
      error: [{ code: 'mdx.too_deep' }],
    });
  });

  it('refuses an answer to a print that holds no bytes', async () => {
    const client = createParseClient({
      url: 'http://parse.internal',
      fetch: answering(200, '{"ok":true,"value":{"issues":[]}}'),
    });
    await expect(client.print(printRequest())).resolves.toMatchObject({
      error: [{ code: 'mdx.parse_failed' }],
    });
  });

  it('refuses an answer with a timing that is not a time', async () => {
    const root = printRequest().root;
    const client = createParseClient({
      url: 'http://parse.internal',
      fetch: answering(
        200,
        JSON.stringify({
          ok: true,
          value: { text: '', ast: root, issues: [], timing: { printMs: 'page text' } },
        }),
      ),
    });
    await expect(client.print(printRequest())).resolves.toMatchObject({
      error: [{ code: 'mdx.parse_failed' }],
    });
  });

  it('passes a refusal from the host through', async () => {
    const answer =
      '{"ok":false,"error":[{"code":"mdx.print_changed_meaning","severity":"error","line":1,"column":1}]}';
    const client = createParseClient({
      url: 'http://parse.internal',
      fetch: answering(200, answer),
    });
    await expect(client.print(printRequest())).resolves.toMatchObject({
      error: [{ code: 'mdx.print_changed_meaning' }],
    });
  });

  const GOOD_ROOT = {
    type: 'root',
    astVersion: 1,
    dialect: 'md',
    eol: 'lf',
    children: [{ type: 'paragraph' }],
    tail: '',
    tailOf: 'x',
  };

  it.each([
    ['no tree', { text: 'a', issues: [] }],
    ['a tree that is not one', { text: 'a', ast: { type: 'root' }, issues: [] }],
    ['a list for a tree', { text: 'a', ast: [], issues: [] }],
    ['the wrong version', { text: 'a', ast: { ...GOOD_ROOT, astVersion: 2 }, issues: [] }],
    ['a child with no kind', { text: 'a', ast: { ...GOOD_ROOT, children: [{}] }, issues: [] }],
    ['text that is not text', { text: 1, ast: GOOD_ROOT, issues: [] }],
  ])('refuses an answer with %s, which a caller would store', async (_name, value) => {
    const answer = JSON.stringify({ ok: true, value });
    const client = createParseClient({
      url: 'http://parse.internal',
      fetch: answering(200, answer),
    });
    await expect(client.print(printRequest())).resolves.toMatchObject({
      error: [{ code: 'mdx.parse_failed' }],
    });
  });

  it('names the organization in a header on both routes, so the host can refuse early', async () => {
    const seen: (string | null)[] = [];
    const client = createParseClient({
      url: 'http://parse.internal',
      fetch: (_url, init) => {
        seen.push(new Headers(init?.headers).get('x-drefyn-organization'));
        return Promise.resolve(new Response('{"ok":false,"error":[]}'));
      },
    });
    await client.parse(page('a'));
    await client.print(printRequest());
    const { organizationId } = page('').tenant;
    expect(seen).toEqual([organizationId, organizationId]);
  });

  it('reads a print answer with bytes in it', async () => {
    const answer = JSON.stringify({ ok: true, value: { text: 'a', ast: GOOD_ROOT, issues: [] } });
    const client = createParseClient({
      url: 'http://parse.internal',
      fetch: answering(200, answer),
    });
    await expect(client.print(printRequest())).resolves.toMatchObject({ ok: true });
  });

  it.each([
    ['a host that is down', () => Promise.reject(new Error('refused')), 'mdx.parse_unavailable'],
    ['a server error', answering(500, 'x'), 'mdx.parse_unavailable'],
    ['an answer that is not JSON', answering(200, 'nonsense'), 'mdx.parse_failed'],
    ['an answer of the wrong shape', answering(200, '{"ok":true}'), 'mdx.parse_failed'],
    [
      'an issue of the wrong shape',
      answering(200, '{"ok":false,"error":[{"code":1}]}'),
      'mdx.parse_failed',
    ],
  ])('turns %s into a refusal', async (_name, fetch, code) => {
    const client = createParseClient({ url: 'http://parse.internal', fetch });
    await expect(client.parse(page('a'))).resolves.toMatchObject({ error: [{ code }] });
  });

  it('refuses an answer past its size cap', async () => {
    const client = createParseClient({
      url: 'http://parse.internal',
      maxAnswerBytes: 8,
      fetch: answering(200, '{"ok":false,"error":[]}'),
    });
    await expect(client.parse(page('a'))).resolves.toMatchObject({
      error: [{ code: 'mdx.parse_failed' }],
    });
  });

  it('reads a busy refusal from a 429', async () => {
    const body = JSON.stringify({
      ok: false,
      error: [{ code: 'mdx.queue_full', severity: 'error', line: 1, column: 1 }],
    });
    const client = createParseClient({ url: 'http://parse.internal', fetch: answering(429, body) });
    await expect(client.parse(page('a'))).resolves.toMatchObject({
      error: [{ code: 'mdx.queue_full' }],
    });
  });

  it('has a timeout on every call', async () => {
    const client = createParseClient({
      url: 'http://parse.internal',
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    });
    await expect(client.parse(page('a'))).resolves.toMatchObject({
      error: [{ code: 'mdx.parse_unavailable' }],
    });
  });
});
