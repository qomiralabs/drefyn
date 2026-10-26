// Start, loss and close: what the client reports and whether it trusts the provider.
import { ErrorCode, OpenFeature, ProviderEvents } from '@openfeature/server-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYNC_AGE_INTERVAL_MS } from '../src/client.ts';
import { createFlagClient, type FlagClient } from '../src/index.ts';
import { FakeProvider } from './support/fake-provider.ts';
import { install, reset } from './support/flagd.ts';
import {
  KILL_SAFE_ON,
  RELEASE,
  ctx,
  entitlements,
  fileConfig,
  fixtureFlags,
  recorders,
  settle,
} from './support/fixtures.ts';

vi.mock('@openfeature/flagd-provider', () => import('./support/flagd.ts'));

const open: FlagClient<typeof fixtureFlags>[] = [];

async function start(fake: FakeProvider, rec = recorders()) {
  install(fake);
  const pending = createFlagClient(fileConfig, {
    entitlements: entitlements().reader,
    registry: fixtureFlags,
    ...rec,
  });
  await vi.advanceTimersByTimeAsync(fileConfig.initTimeoutMs);
  const client = await pending;
  open.push(client);
  return client;
}

const readyGauge = (rec: ReturnType<typeof recorders>) =>
  rec.gauge.mock.calls.filter(([name]) => name === 'flags_provider_ready').at(-1)?.[1];

const notReadyLogs = (rec: ReturnType<typeof recorders>) =>
  rec.warn.mock.calls.filter(([event]) => event === 'flags.provider_not_ready');

beforeEach(() => {
  vi.useFakeTimers();
  reset();
});

afterEach(async () => {
  for (const client of open.splice(0)) await client.close();
  vi.useRealTimers();
});

describe('a start that fails', () => {
  it('is not treated as ready: safe values with FLAG_PROVIDER_NOT_READY, provider untouched', async () => {
    const rec = recorders();
    const fake = new FakeProvider('reject').setAll({ kind: 'value', value: true });
    const client = await start(fake, rec);
    expect(readyGauge(rec)).toBe(0);
    expect(await settle(client.evaluate(RELEASE, ctx))).toEqual({
      value: false,
      source: 'safe_value',
      errorCode: 'FLAG_PROVIDER_NOT_READY',
    });
    expect(await settle(client.evaluate(KILL_SAFE_ON, ctx))).toEqual({
      value: true,
      source: 'safe_value',
      errorCode: 'FLAG_PROVIDER_NOT_READY',
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('logs once with reason failed, however many errors follow', async () => {
    const rec = recorders();
    const fake = new FakeProvider('reject');
    await start(fake, rec);
    fake.emit(ProviderEvents.Error);
    fake.emit(ProviderEvents.Stale);
    fake.emit(ProviderEvents.Error);
    await vi.advanceTimersByTimeAsync(0);
    expect(notReadyLogs(rec)).toHaveLength(1);
    expect(notReadyLogs(rec)[0]?.[1]).toMatchObject({ reason: 'failed', source: 'file' });
  });

  it('serves provider values once the provider reconnects', async () => {
    const rec = recorders();
    const fake = new FakeProvider('reject').set(RELEASE, { kind: 'value', value: true });
    const client = await start(fake, rec);
    fake.emit(ProviderEvents.Ready);
    await vi.advanceTimersByTimeAsync(0);
    expect(await client.evaluate(RELEASE, ctx)).toEqual({ value: true, source: 'provider' });
    expect(readyGauge(rec)).toBe(1);
  });
});

describe('a start that times out', () => {
  it('logs reason timeout, even when the provider reported an error during the wait', async () => {
    const rec = recorders();
    const fake = new FakeProvider('hang');
    install(fake);
    const pending = createFlagClient(fileConfig, {
      entitlements: entitlements().reader,
      registry: fixtureFlags,
      ...rec,
    });
    await vi.advanceTimersByTimeAsync(10);
    fake.emit(ProviderEvents.Error);
    await vi.advanceTimersByTimeAsync(fileConfig.initTimeoutMs);
    open.push(await pending);
    expect(notReadyLogs(rec)).toHaveLength(1);
    expect(notReadyLogs(rec)[0]?.[1]).toMatchObject({ reason: 'timeout' });
  });
});

describe('a provider that has failed for good', () => {
  it.each<[string, (fake: FakeProvider) => void]>([
    [
      'by event',
      (fake) => {
        fake.emit(ProviderEvents.Error, ErrorCode.PROVIDER_FATAL);
      },
    ],
    [
      'by result',
      (fake) => {
        fake.set(RELEASE, {
          kind: 'error_result',
          errorCode: ErrorCode.PROVIDER_FATAL,
          value: true,
        });
      },
    ],
  ])('maps PROVIDER_FATAL to FLAG_PROVIDER_NOT_READY (%s)', async (_label, fail) => {
    const fake = new FakeProvider().set(RELEASE, { kind: 'value', value: true });
    const client = await start(fake);
    fail(fake);
    expect(await settle(client.evaluate(RELEASE, ctx))).toEqual({
      value: false,
      source: 'safe_value',
      errorCode: 'FLAG_PROVIDER_NOT_READY',
    });
  });
});

describe('sync state events', () => {
  it('ConfigurationChanged after a loss counts as in sync again', async () => {
    const rec = recorders();
    const fake = new FakeProvider();
    await start(fake, rec);
    fake.emit(ProviderEvents.Stale);
    await vi.advanceTimersByTimeAsync(0);
    expect(readyGauge(rec)).toBe(0);
    fake.emit(ProviderEvents.ConfigurationChanged);
    await vi.advanceTimersByTimeAsync(0);
    expect(readyGauge(rec)).toBe(1);
  });

  it('are no longer handled after close', async () => {
    const rec = recorders();
    const fake = new FakeProvider('reject');
    const client = await start(fake, rec);
    await client.close();
    rec.gauge.mockClear();
    rec.warn.mockClear();
    for (const event of [
      ProviderEvents.Ready,
      ProviderEvents.Stale,
      ProviderEvents.Error,
      ProviderEvents.ConfigurationChanged,
    ]) {
      fake.emit(event);
    }
    await vi.advanceTimersByTimeAsync(SYNC_AGE_INTERVAL_MS);
    expect(rec.gauge).not.toHaveBeenCalled();
    expect(rec.warn).not.toHaveBeenCalled();
  });
});

describe('each client', () => {
  it('gets its own OpenFeature domain with a random suffix', async () => {
    const getClient = vi.spyOn(OpenFeature, 'getClient');
    await start(new FakeProvider());
    await start(new FakeProvider());
    const domains = getClient.mock.calls.map(([domain]) => domain);
    expect(domains).toHaveLength(2);
    for (const domain of domains) {
      expect(domain).toMatch(
        /^drefyn-flags-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
    expect(domains[0]).not.toBe(domains[1]);
  });
});

describe('the gauge tick', () => {
  it('does not hold the process open', async () => {
    vi.useRealTimers();
    const setInterval = vi.spyOn(globalThis, 'setInterval');
    install(new FakeProvider('none'));
    const client = await createFlagClient(fileConfig, {
      entitlements: entitlements().reader,
      registry: fixtureFlags,
    });
    open.push(client);
    const ticks = setInterval.mock.results
      .filter((_r, i) => setInterval.mock.calls[i]?.[1] === SYNC_AGE_INTERVAL_MS)
      .map((r) => r.value as NodeJS.Timeout);
    expect(ticks).toHaveLength(1);
    expect(ticks[0]?.hasRef()).toBe(false);
  });
});
