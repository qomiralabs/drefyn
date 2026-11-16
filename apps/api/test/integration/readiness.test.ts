import type { Hono } from 'hono';
import { beforeAll, expect, it } from 'vitest';
import { createApp, type ApiEnv } from '../../src/app.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';

const fresh = harness();
let h: Harness;
let app: Hono<ApiEnv>;

const env = { incoming: { socket: { remoteAddress: '203.0.113.1' } } };
const status = async (path: string) => (await app.request(path, {}, env)).status;

// The pool may still hold a connection that was dropped; one failed ping clears it.
async function eventually(path: string, want: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  let last = 0;
  while (Date.now() < deadline) {
    last = await status(path);
    if (last === want) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(last).toBe(want);
}

describeWithStack('readiness against Postgres', () => {
  beforeAll(async () => {
    h = await fresh();
    const unused = () => Promise.reject(new Error('not used'));
    app = createApp({
      db: h.db,
      published: h.published,
      keys: { verifyApiKey: unused, verifyApiRequest: unused },
      failures: { reserve: unused },
      flags: { isOn: unused, evaluate: unused, close: () => Promise.resolve() },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      config: { hops: 0, viewerHeader: false, maxBodyBytes: 1024 },
    });
  });

  it('is ready with both pools up', async () => {
    expect(await status('/readyz')).toBe(200);
    expect(await status('/healthz')).toBe(200);
  });

  it.each(['reader', 'app'] as const)(
    'fails /readyz while the %s pool cannot connect, and /healthz does not',
    async (role) => {
      const restore = await h.cutOff(role);
      try {
        await eventually('/readyz', 503);
        expect(await status('/healthz')).toBe(200);
      } finally {
        await restore();
      }
      await eventually('/readyz', 200);
    },
  );
});
