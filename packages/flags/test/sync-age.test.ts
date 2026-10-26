// flags_last_sync_age_seconds is pushed on every change of sync state and on a fixed tick
// while the client is open. It is 0 while the provider is in sync, and otherwise counts
// from the moment sync was lost, or from client start if the provider never synced. A push
// sink only sees a growing age if something pushes it, hence the tick.
import { ErrorCode, ProviderEvents } from '@openfeature/server-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYNC_AGE_INTERVAL_MS } from '../src/client.ts';
import { createFlagClient, type FlagClient } from '../src/index.ts';
import { FakeProvider } from './support/fake-provider.ts';
import { install, reset } from './support/flagd.ts';
import { entitlements, fileConfig, fixtureFlags, recorders } from './support/fixtures.ts';

vi.mock('@openfeature/flagd-provider', () => import('./support/flagd.ts'));

const open: FlagClient<typeof fixtureFlags>[] = [];

async function start(fake: FakeProvider, rec: ReturnType<typeof recorders>, hangs = false) {
  install(fake);
  const pending = createFlagClient(fileConfig, {
    entitlements: entitlements().reader,
    registry: fixtureFlags,
    ...rec,
  });
  // A provider that hangs holds the start for the whole init wait.
  if (hangs) await vi.advanceTimersByTimeAsync(fileConfig.initTimeoutMs);
  const client = await pending;
  open.push(client);
  return client;
}

function ages(rec: ReturnType<typeof recorders>): number[] {
  return rec.gauge.mock.calls
    .filter(([name]) => name === 'flags_last_sync_age_seconds')
    .map(([, value]) => value);
}

beforeEach(() => {
  vi.useFakeTimers();
  reset();
});

afterEach(async () => {
  for (const client of open.splice(0)) await client.close();
  vi.useRealTimers();
});

describe('flags_last_sync_age_seconds', () => {
  it('ticks every 15 seconds', () => {
    expect(SYNC_AGE_INTERVAL_MS).toBe(15_000);
  });

  it('is 0 at start and on every tick while the provider is in sync', async () => {
    const rec = recorders();
    await start(new FakeProvider(), rec);
    expect(ages(rec).at(-1)).toBe(0);
    rec.gauge.mockClear();
    await vi.advanceTimersByTimeAsync(3 * SYNC_AGE_INTERVAL_MS);
    expect(ages(rec)).toEqual([0, 0, 0]);
  });

  const losses: [string, (fake: FakeProvider) => void][] = [
    [
      'stale',
      (fake) => {
        fake.emit(ProviderEvents.Stale);
      },
    ],
    [
      'error',
      (fake) => {
        fake.emit(ProviderEvents.Error);
      },
    ],
    [
      'fatal',
      (fake) => {
        fake.emit(ProviderEvents.Error, ErrorCode.PROVIDER_FATAL);
      },
    ],
  ];

  it.each(losses)(
    'counts from the moment sync is lost (%s) and is pushed at once',
    async (_label, lose) => {
      const rec = recorders();
      const fake = new FakeProvider();
      await start(fake, rec);
      await vi.advanceTimersByTimeAsync(5_000);
      rec.gauge.mockClear();
      lose(fake);
      await vi.advanceTimersByTimeAsync(0);
      expect(ages(rec)).toEqual([0]);
      // The ticks land 10 s and 25 s after the loss.
      await vi.advanceTimersByTimeAsync(25_000);
      expect(ages(rec)).toEqual([0, 10, 25]);
    },
  );

  it('counts from client start when the provider never synced', async () => {
    const rec = recorders();
    await start(new FakeProvider('hang'), rec, true);
    expect(ages(rec).at(-1)).toBe(fileConfig.initTimeoutMs / 1000);
    await vi.advanceTimersByTimeAsync(SYNC_AGE_INTERVAL_MS);
    expect(ages(rec).at(-1)).toBe(15);
  });

  it('drops back to 0 as soon as the provider is in sync again', async () => {
    const rec = recorders();
    const fake = new FakeProvider();
    await start(fake, rec);
    fake.emit(ProviderEvents.Stale);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(ages(rec).at(-1)).toBe(30);
    fake.emit(ProviderEvents.Ready);
    await vi.advanceTimersByTimeAsync(0);
    expect(ages(rec).at(-1)).toBe(0);
    const ready = rec.gauge.mock.calls.filter(([name]) => name === 'flags_provider_ready');
    expect(ready.at(-1)?.[1]).toBe(1);
  });

  it('is not pushed after close, and close leaves no tick behind', async () => {
    const rec = recorders();
    const before = vi.getTimerCount();
    const client = await start(new FakeProvider(), rec);
    await client.close();
    expect(vi.getTimerCount()).toBe(before);
    rec.gauge.mockClear();
    await vi.advanceTimersByTimeAsync(5 * SYNC_AGE_INTERVAL_MS);
    expect(rec.gauge).not.toHaveBeenCalled();
  });

  it('carries only the source label', async () => {
    const rec = recorders();
    const fake = new FakeProvider();
    await start(fake, rec);
    fake.emit(ProviderEvents.Error);
    await vi.advanceTimersByTimeAsync(SYNC_AGE_INTERVAL_MS);
    for (const [, , labels] of rec.gauge.mock.calls) expect(labels).toEqual({ source: 'file' });
  });
});
