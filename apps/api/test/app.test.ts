import type * as DbModule from '@drefyn/db';
import { DbError } from '@drefyn/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, READY_TIMEOUT_MS } from '../src/app.ts';
import { ApiError } from '../src/errors.ts';
import { GOOD, fakeDeps, socketEnv } from './support.ts';

const pings: { db: unknown; timeoutMs: number }[] = [];
const down = new Set<unknown>();

vi.mock('@drefyn/db', async (original) => {
  const actual = await original<typeof DbModule>();
  return {
    ...actual,
    pingDatabase: (db: unknown, timeoutMs: number) => {
      pings.push({ db, timeoutMs });
      return down.has(db)
        ? Promise.reject(new actual.DbError('DB_UNAVAILABLE', 'down'))
        : Promise.resolve();
    },
  };
});

beforeEach(() => {
  pings.length = 0;
  down.clear();
});

describe('health and readiness', () => {
  it('answers /healthz without touching either pool', async () => {
    const { deps } = fakeDeps();
    down.add(deps.db);
    down.add(deps.published);
    const response = await createApp(deps).request('/healthz', {}, socketEnv());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(pings).toEqual([]);
  });

  // Probes come every few seconds; a line each would bury the requests that matter.
  it('logs no request line for a passing probe, and one for a failing probe', async () => {
    const { deps, logs } = fakeDeps();
    const app = createApp(deps);
    await app.request('/healthz', {}, socketEnv());
    await app.request('/readyz', {}, socketEnv());
    expect(logs.filter((l) => l.event === 'api.request')).toEqual([]);
    down.add(deps.db);
    await app.request('/readyz', {}, socketEnv());
    expect(logs.filter((l) => l.event === 'api.request')).toMatchObject([
      { fields: { route: '/readyz', status: 503 } },
    ]);
  });

  it('answers /readyz when both pools answer', async () => {
    const { deps } = fakeDeps();
    const response = await createApp(deps).request('/readyz', {}, socketEnv());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready' });
    expect(pings).toEqual([
      { db: deps.db, timeoutMs: READY_TIMEOUT_MS },
      { db: deps.published, timeoutMs: READY_TIMEOUT_MS },
    ]);
  });

  it.each([
    ['app', true, false],
    ['reader', false, true],
    ['both', true, true],
  ])('fails /readyz with 503 when the %s pool is down', async (_label, appDown, readerDown) => {
    const { deps, logs } = fakeDeps();
    if (appDown) down.add(deps.db);
    if (readerDown) down.add(deps.published);
    const response = await createApp(deps).request('/readyz', {}, socketEnv());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: 'api.unavailable', message: 'The service is unavailable. Try again.' },
    });
    expect(response.headers.get('retry-after')).toBe('1');
    expect(logs).toContainEqual({
      level: 'warn',
      event: 'api.not_ready',
      fields: { app: !appDown, reader: !readerDown },
    });
  });
});

describe('every response', () => {
  it('answers an unknown path with the one error body', async () => {
    const { deps } = fakeDeps();
    const response = await createApp(deps).request('/v1/nothing', {}, socketEnv());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: 'api.not_found', message: 'Not found.' },
    });
  });

  it('carries a request id and nosniff', async () => {
    const { deps } = fakeDeps();
    const response = await createApp(deps).request('/healthz', {}, socketEnv());
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  // CORS is off: no browser on another origin may read an answer.
  it('sends no CORS headers', async () => {
    const { deps } = fakeDeps();
    const response = await createApp(deps).request(
      '/healthz',
      { headers: { origin: 'https://evil.example' } },
      socketEnv(),
    );
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('refuses a body over the limit with 413 before the handler reads it', async () => {
    const { deps } = fakeDeps();
    const app = createApp(deps);
    const handler = vi.fn(() => new Response('read'));
    app.post('/v1/echo', handler);
    const response = await app.request(
      '/v1/echo',
      { method: 'POST', body: 'x'.repeat(2048), headers: { 'content-type': 'text/plain' } },
      socketEnv(),
    );
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'api.too_large',
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers an ApiError thrown by a handler with its own code', async () => {
    const { deps } = fakeDeps();
    const app = createApp(deps);
    app.get('/v1/limit', () => {
      throw new ApiError('api.limit_reached', { retryAfterSeconds: 5 });
    });
    const response = await app.request('/v1/limit', {}, socketEnv());
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('5');
  });

  it('answers anything else as 500 and logs the error name only', async () => {
    const { deps, logs } = fakeDeps();
    const app = createApp(deps);
    app.get('/v1/boom', () => {
      throw new DbError('DB_UNAVAILABLE', 'secret detail');
    });
    const response = await app.request('/v1/boom', {}, socketEnv());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: 'api.internal', message: 'Something went wrong on our side.' },
    });
    expect(logs).toContainEqual({
      level: 'error',
      event: 'api.unhandled_error',
      fields: { error: 'DbError' },
    });
    expect(JSON.stringify(logs)).not.toContain('secret detail');
  });
});

describe('client address', () => {
  async function ipSeen(
    hops: number,
    headers: Record<string, string>,
    viewerHeader = false,
    remote: string | null = '10.0.0.2',
  ) {
    const base = fakeDeps();
    const deps = { ...base.deps, config: { hops, viewerHeader, maxBodyBytes: 1024 } };
    const app = createApp(deps);
    let seen = '';
    app.get('/v1/ip', (c) => {
      seen = c.get('clientIp');
      return c.json({});
    });
    const response = await app.request('/v1/ip', { headers }, socketEnv(remote));
    return { seen, logs: base.logs, status: response.status };
  }

  it('uses the socket with no proxy hops, ignoring a forged X-Forwarded-For', async () => {
    expect((await ipSeen(0, { 'x-forwarded-for': '198.51.100.7' })).seen).toBe('10.0.0.2');
  });

  it('takes the address the trusted hop appended', async () => {
    expect((await ipSeen(1, { 'x-forwarded-for': '198.51.100.7, 203.0.113.20' })).seen).toBe(
      '203.0.113.20',
    );
  });

  it('reads the viewer header from the trusted hop when configured', async () => {
    expect((await ipSeen(1, { 'cloudfront-viewer-address': '203.0.113.9:443' }, true)).seen).toBe(
      '203.0.113.9',
    );
  });

  it('logs a chain shorter than the hops, with no address in the line', async () => {
    const { seen, logs } = await ipSeen(2, { 'x-forwarded-for': '198.51.100.7' });
    expect(seen).toBe('198.51.100.7');
    expect(logs).toContainEqual({
      level: 'warn',
      event: 'api.client_ip_chain_invalid',
      fields: { hops: 2 },
    });
    expect(JSON.stringify(logs)).not.toContain('198.51.100.7');
  });

  it('answers 503 when the socket has no address left', async () => {
    const { status } = await ipSeen(0, { authorization: GOOD }, false, null);
    expect(status).toBe(503);
  });
});
