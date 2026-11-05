import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createParseClient } from '../src/client.ts';
import { startParseHost } from '../src/host.ts';
import type { ParseHost } from '../src/host.ts';
import { DEFAULT_LIMITS } from '../src/index.ts';
import type { ParseResult } from '../src/index.ts';
import { refused } from '../src/result.ts';
import { maxBodyBytes } from '../src/wire.ts';
import { isolatedPolicy, ORG_A, parsed, poolConfig, PROJECT_A, PROJECT_B } from './helpers.ts';

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
    const answer = await fetch(`${url}/parse`, { method: 'POST', body }).then(
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
    const small = await fetch(`${url}/print`, { method: 'POST', body });
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
