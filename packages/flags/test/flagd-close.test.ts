// The real flagd provider in sync mode against a port nothing listens on. The unpatched
// provider kept retrying after close (a closed channel fails waitForReady at once, which
// schedules the next attempt), holding the process open. Attempts are counted at the gRPC
// client, so the test needs no network of its own.
import { Client } from '@grpc/grpc-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFlagClient } from '../src/index.ts';
import { RELEASE, ctx, entitlements, fixtureFlags } from './support/fixtures.ts';

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('closing a client in flagd mode with the real provider', { timeout: 15_000 }, () => {
  it('stops every connection attempt and leaves no timer behind', async () => {
    const attempts = vi.spyOn(Client.prototype, 'waitForReady');
    const baseline = timers();
    const client = await createFlagClient(
      // Port 1 refuses at once on loopback, so the provider is retrying when close runs.
      { source: 'flagd', host: '127.0.0.1', syncPort: 1, evalTimeoutMs: 50, initTimeoutMs: 300 },
      { entitlements: entitlements().reader, registry: fixtureFlags },
    );
    await sleep(700);
    expect(attempts.mock.calls.length).toBeGreaterThan(0);
    expect((await client.evaluate(RELEASE, ctx)).value).toBe(false);

    await client.close();
    const atClose = attempts.mock.calls.length;
    await sleep(3000);
    expect(attempts.mock.calls.length - atClose).toBeLessThanOrEqual(0);
    expect(timers()).toBeLessThanOrEqual(baseline);
  });
});
