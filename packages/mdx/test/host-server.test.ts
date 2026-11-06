import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createParseClient } from '../src/client.ts';
import { startParseHost } from '../src/host.ts';
import type { ParseHost } from '../src/host.ts';
import { DEFAULT_LIMITS } from '../src/index.ts';
import type { ParseResult } from '../src/index.ts';
import { refused } from '../src/result.ts';
import { maxBodyBytes, maxMergeBodyBytes } from '../src/wire.ts';
import {
  isolatedPolicy,
  ORG_A,
  ORG_B,
  parsed,
  poolConfig,
  PROJECT_A,
  PROJECT_B,
} from './helpers.ts';

const wireOf = (policy: ReturnType<typeof isolatedPolicy>) => ({
  ...policy,
  components: [...policy.components],
});

// The server alone, with threads that answer by rule. Real hosts are in host.test.ts.
describe('the host server', () => {
  let host: ParseHost;
  let url: string;
  const hold: ((result: ParseResult) => void)[] = [];

  beforeAll(async () => {
    host = await startParseHost({
      config: poolConfig({
        orgThreads: 1,
        maxQueued: 2,
        maxQueuedPerOrg: 1,
        maxQueuedPerProject: 1,
      }),
      port: 0,
      logger: { warn: () => undefined },
      startThread: () => ({
        alive: () => true,
        stop: () => Promise.resolve(),
        run: () =>
          new Promise((resolve) => {
            hold.push((result) => {
              resolve({ result, end: 'reusable', workMs: 1 });
            });
          }),
      }),
    });
    const address = host.server.address();
    if (typeof address !== 'object' || address === null) throw new Error('no port');
    url = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    host.server.closeAllConnections();
    await new Promise((resolve) => host.server.close(resolve));
  });

  const page = (projectId = PROJECT_A) => ({
    tenant: { organizationId: ORG_A, projectId },
    path: 'a.md',
    source: 'a',
    dialect: 'md' as const,
    policy: isolatedPolicy(),
  });

  it('answers a health check', async () => {
    expect((await fetch(`${url}/health`)).status).toBe(200);
  });

  it.each([
    ['GET', '/parse'],
    ['POST', '/other'],
  ])('has nothing at %s %s', async (method, path) => {
    expect((await fetch(`${url}${path}`, { method })).status).toBe(404);
  });

  it('refuses a body that is not a frame, and says nothing about it', async () => {
    const response = await fetch(`${url}/parse`, { method: 'POST', body: 'CANARY-PAGE-TEXT' });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('');
  });

  it('refuses a frame with a forged tenant', async () => {
    const frame = { ...page(), tenant: { organizationId: 'x', projectId: 'y' } };
    const body = JSON.stringify({ ...frame, policy: { ...frame.policy, components: [] } });
    expect((await fetch(`${url}/parse`, { method: 'POST', body })).status).toBe(400);
  });

  it('cuts a body past its cap', async () => {
    const body = 'x'.repeat(maxBodyBytes(DEFAULT_LIMITS.maxBytes) + 1);
    const headers = { 'x-drefyn-organization': ORG_A };
    const answer = await fetch(`${url}/parse`, { method: 'POST', body, headers }).then(
      ({ status }) => status,
      () => 'cut',
    );
    expect([413, 'cut']).toContain(answer);
  });

  it('takes a print on its own route, under the same limits', async () => {
    const client = createParseClient({ url });
    const printed = client.print({
      tenant: { organizationId: ORG_A, projectId: PROJECT_A },
      path: 'docs/page.mdx',
      root: parsed('a\n', 'md'),
      policy: isolatedPolicy(),
    });
    await expect.poll(() => hold.length).toBe(1);
    hold.shift()?.(refused('mdx.print_changed_meaning'));
    await expect(printed).resolves.toEqual(refused('mdx.print_changed_meaning'));
  });

  it('takes a merge on its own route, under the same limits', async () => {
    const client = createParseClient({ url });
    const root = parsed('a\n', 'md');
    const merged = client.merge({
      tenant: { organizationId: ORG_A, projectId: PROJECT_A },
      path: 'docs/page.mdx',
      base: root,
      ours: root,
      theirs: root,
      policy: isolatedPolicy(),
    });
    await expect.poll(() => hold.length).toBe(1);
    hold.shift()?.(refused('mdx.merge_limit'));
    await expect(merged).resolves.toEqual(refused('mdx.merge_limit'));
  });

  it('refuses a merge frame that is not one, and cuts a body past its cap', async () => {
    const headers = { 'x-drefyn-organization': ORG_A };
    const response = await fetch(`${url}/merge`, {
      method: 'POST',
      body: 'CANARY-PAGE-TEXT',
      headers,
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('');
    expect((await fetch(`${url}/merge`)).status).toBe(404);
    const tenant = { organizationId: ORG_B, projectId: PROJECT_A };
    const frame = { tenant, path: 'a.md', trees: '{}', policy: wireOf(isolatedPolicy()) };
    const other = await fetch(`${url}/merge`, {
      method: 'POST',
      body: JSON.stringify(frame),
      headers,
    });
    expect(other.status).toBe(400);
    const declared = maxMergeBodyBytes(DEFAULT_LIMITS.maxBytes) + 1;
    const big = await fetch(`${url}/merge`, {
      method: 'POST',
      body: new Uint8Array(1),
      headers: { ...headers, 'content-length': String(declared) },
      duplex: 'half',
    } as RequestInit).catch(() => undefined);
    expect(big === undefined || big.status === 413).toBe(true);
  });

  it('refuses a print frame that is not one, and says nothing about it', async () => {
    const response = await fetch(`${url}/print`, { method: 'POST', body: 'CANARY-PAGE-TEXT' });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('');
    const frame = { ...page(), policy: { ...page().policy, components: [] } };
    expect(
      (await fetch(`${url}/print`, { method: 'POST', body: JSON.stringify(frame) })).status,
    ).toBe(400);
  });

  it('has no print on a GET, and cuts a print body past its own cap', async () => {
    expect((await fetch(`${url}/print`)).status).toBe(404);
    const body = 'x'.repeat(maxBodyBytes(DEFAULT_LIMITS.maxBytes) + 1);
    const headers = { 'x-drefyn-organization': ORG_A };
    const small = await fetch(`${url}/print`, { method: 'POST', body, headers });
    expect(small.status).toBe(400);
  });

  it('answers a page, and turns busy refusals into a 429 a client can read', async () => {
    const client = createParseClient({ url });
    const first = client.parse(page());
    await expect.poll(() => hold.length).toBe(1);
    const queued = client.parse(page());
    await expect.poll(() => host.pool.stats().queued).toBe(1);
    await expect(client.parse(page(PROJECT_B))).resolves.toEqual(refused('mdx.organization_limit'));
    hold.shift()?.(refused('mdx.parse_failed'));
    await expect(first).resolves.toEqual(refused('mdx.parse_failed'));
    await expect.poll(() => hold.length).toBe(1);
    hold.shift()?.(refused('mdx.parse_failed'));
    await queued;
  });
});

describe('the bytes a host holds', () => {
  const SHARE = 4_000;
  const ORG_HEADER = 'x-drefyn-organization';
  let host: ParseHost;
  let url: string;
  const hold: ((result: ParseResult) => void)[] = [];

  beforeAll(async () => {
    host = await startParseHost({
      config: poolConfig({ threads: 4, orgThreads: 3, projectThreads: 3 }),
      maxHeldBytes: SHARE * 4,
      port: 0,
      logger: { warn: () => undefined },
      startThread: () => ({
        alive: () => true,
        stop: () => Promise.resolve(),
        run: () =>
          new Promise((resolve) => {
            hold.push((result) => {
              resolve({ result, end: 'reusable', workMs: 1 });
            });
          }),
      }),
    });
    const address = host.server.address();
    if (typeof address !== 'object' || address === null) throw new Error('no port');
    url = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    host.server.closeAllConnections();
    await new Promise((resolve) => host.server.close(resolve));
  });

  const frame = (organizationId: string, bytes: number) => ({
    tenant: { organizationId, projectId: PROJECT_A },
    path: 'docs/page.mdx',
    source: 'a'.repeat(bytes),
    dialect: 'md',
    policy: { ...isolatedPolicy(), components: [] },
  });
  const post = (organization: string | undefined, body: string) =>
    fetch(`${url}/parse`, {
      method: 'POST',
      body,
      headers: organization === undefined ? {} : { [ORG_HEADER]: organization },
    });
  // A stream has no declared length, and this one never ends unless the host ends it.
  const streamed = async (chunks: readonly string[], signal?: AbortSignal) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      },
    });
    const init = {
      method: 'POST',
      body,
      duplex: 'half',
      headers: { [ORG_HEADER]: ORG_A },
      ...(signal && { signal }),
    };
    return (await fetch(`${url}/parse`, init as RequestInit)).status;
  };
  const sized = (organizationId: string, bytes: number) =>
    JSON.stringify(frame(organizationId, bytes));
  const finishAll = async () => {
    while (hold.length > 0) {
      hold.shift()?.(refused('mdx.parse_failed'));
      await Promise.resolve();
    }
    await expect.poll(() => host.pool.stats().busy).toBe(0);
  };

  it('needs the organization before it reads a body', async () => {
    expect((await post(undefined, sized(ORG_A, 1))).status).toBe(400);
    expect((await post('', sized(ORG_A, 1))).status).toBe(400);
  });

  it('checks the organization against the frame', async () => {
    expect((await post(ORG_B, sized(ORG_A, 1))).status).toBe(400);
  });

  it('refuses on a declared length, without reading the body', async () => {
    const response = await post(ORG_A, sized(ORG_A, SHARE + 1));
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual(refused('mdx.queue_full'));
    expect(hold).toEqual([]);
  });

  it('refuses a body with no declared length as soon as it passes the share', async () => {
    const answer = await streamed(['x'.repeat(SHARE + 1)]);
    expect(answer).toBe(429);
  });

  it('counts a queued job until it finishes, and only against its organization', async () => {
    const first = post(ORG_A, sized(ORG_A, SHARE / 2));
    await expect.poll(() => hold.length).toBe(1);
    expect((await post(ORG_A, sized(ORG_A, SHARE / 2))).status).toBe(429);
    const other = post(ORG_B, sized(ORG_B, SHARE / 2));
    await expect.poll(() => hold.length).toBe(2);
    await finishAll();
    await first;
    await other;
    const again = post(ORG_A, sized(ORG_A, SHARE / 2));
    await expect.poll(() => hold.length).toBe(1);
    await finishAll();
    await again;
  });

  it('gives back what a frame that fails its checks held', async () => {
    for (let round = 0; round < 8; round += 1) {
      expect((await post(ORG_A, 'x'.repeat(SHARE - 1))).status).toBe(400);
    }
  });

  it('gives back what a body cut off half way held', async () => {
    const stop = new AbortController();
    const sending = streamed(['x'.repeat(SHARE - 10)], stop.signal).catch(() => 'cut');
    await delay(50);
    stop.abort();
    await sending;
    await expect.poll(async () => (await post(ORG_A, 'x'.repeat(SHARE - 1))).status).toBe(400);
  });
});
