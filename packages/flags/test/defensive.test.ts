// Failures outside the provider: the SDK client itself, the injected sinks and the
// entitlements reader can all misbehave, and none of them may break an evaluation.
import { OpenFeature, ProviderEvents, ProviderStatus } from '@openfeature/server-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlagClient, type FlagClient, type FlagClientDeps } from '../src/index.ts';
import { createTestFlagClient } from '../src/testing.ts';
import { FakeProvider } from './support/fake-provider.ts';
import { install, reset } from './support/flagd.ts';
import {
  KILL_SAFE_ON,
  PLAN,
  RELEASE,
  ctx,
  entitlements,
  fileConfig,
  fixtureFlags,
  settle,
} from './support/fixtures.ts';

vi.mock('@openfeature/flagd-provider', () => import('./support/flagd.ts'));

type Fixture = typeof fixtureFlags;
const open: FlagClient<Fixture>[] = [];

async function boot(fake: FakeProvider, deps: Partial<FlagClientDeps<Fixture>> = {}) {
  install(fake);
  const client = await createFlagClient(fileConfig, {
    entitlements: entitlements().reader,
    registry: fixtureFlags,
    ...deps,
  });
  open.push(client);
  return client;
}

// Makes every OpenFeature client the package creates answer `prop` with `answer`.
function breakSdkClients(prop: 'getBooleanDetails' | 'providerStatus', answer: () => unknown) {
  const getClient = OpenFeature.getClient.bind(OpenFeature) as (...args: unknown[]) => object;
  vi.spyOn(OpenFeature, 'getClient').mockImplementation(((...args: unknown[]) => {
    const client = getClient(...args);
    return new Proxy(client, {
      get(target, key) {
        if (key === prop) return prop === 'providerStatus' ? answer() : answer;
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  }) as unknown as typeof OpenFeature.getClient);
}

beforeEach(() => {
  vi.useFakeTimers();
  reset();
});

afterEach(async () => {
  for (const client of open.splice(0)) await client.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('an SDK client that misbehaves', () => {
  it('keeps a release flag off when reading its provider status throws', async () => {
    breakSdkClients('providerStatus', () => {
      throw new Error('sdk bug');
    });
    const client = await boot(new FakeProvider().set(RELEASE, { kind: 'value', value: true }));
    expect(await settle(client.evaluate(RELEASE, ctx))).toEqual({
      value: false,
      source: 'safe_value',
      errorCode: 'FLAG_PROVIDER_NOT_READY',
    });
    expect(await settle(client.isOn(RELEASE, ctx))).toBe(false);
  });

  it('gives a kill switch its safe value when reading its provider status throws', async () => {
    breakSdkClients('providerStatus', () => {
      throw new Error('sdk bug');
    });
    const client = await boot(
      new FakeProvider().set(KILL_SAFE_ON, { kind: 'value', value: false }),
    );
    expect(await settle(client.evaluate(KILL_SAFE_ON, ctx))).toEqual({
      value: true,
      source: 'safe_value',
      errorCode: 'FLAG_PROVIDER_NOT_READY',
    });
  });

  // Its boolean methods run hooks, so evaluation never calls them.
  it.each<[string, () => unknown]>([
    [
      'throws',
      () => {
        throw new Error('sdk bug');
      },
    ],
    ['rejects', () => Promise.reject(new Error('sdk bug'))],
    ['answers true', () => Promise.resolve({ value: true, flagKey: RELEASE, flagMetadata: {} })],
  ])('is not on the evaluation path when getBooleanDetails %s', async (_label, answer) => {
    breakSdkClients('getBooleanDetails', answer);
    const client = await boot(new FakeProvider().set(RELEASE, { kind: 'value', value: false }));
    expect(await settle(client.evaluate(RELEASE, ctx))).toEqual({
      value: false,
      source: 'provider',
    });
  });
});

describe('the provider status check', () => {
  // A status added by a future SDK must be looked at before it can serve flags.
  it('knows every status the SDK has', () => {
    expect(Object.values(ProviderStatus).sort()).toEqual([
      'ERROR',
      'FATAL',
      'NOT_READY',
      'READY',
      'STALE',
    ]);
  });

  // Stale and error keep answering: the in process provider serves its last synced values.
  it.each<[string, unknown, boolean]>([
    ['READY', ProviderStatus.READY, true],
    ['STALE', ProviderStatus.STALE, true],
    ['ERROR', ProviderStatus.ERROR, true],
    ['NOT_READY', ProviderStatus.NOT_READY, false],
    ['FATAL', ProviderStatus.FATAL, false],
    ['an unknown status', 'RECONCILING', false],
    ['undefined', undefined, false],
  ])('uses the provider only when it is %s and allowed', async (_label, status, usable) => {
    breakSdkClients('providerStatus', () => status);
    const fake = new FakeProvider()
      .set(RELEASE, { kind: 'value', value: true })
      .set(KILL_SAFE_ON, { kind: 'value', value: false });
    const client = await boot(fake);
    expect(await settle(client.evaluate(RELEASE, ctx))).toEqual(
      usable
        ? { value: true, source: 'provider' }
        : { value: false, source: 'safe_value', errorCode: 'FLAG_PROVIDER_NOT_READY' },
    );
    expect(await settle(client.evaluate(KILL_SAFE_ON, ctx))).toEqual(
      usable
        ? { value: false, source: 'provider' }
        : { value: true, source: 'safe_value', errorCode: 'FLAG_PROVIDER_NOT_READY' },
    );
    expect(fake.calls).toHaveLength(usable ? 2 : 0);
  });
});

describe('an error whose code cannot be read', () => {
  const hostileErrors: [string, () => unknown][] = [
    [
      'a code getter that throws',
      () =>
        Object.defineProperty(new Error('boom'), 'code', {
          get() {
            throw new Error('getter');
          },
        }),
    ],
    [
      'a proxy whose has trap throws',
      () =>
        new Proxy(
          {},
          {
            has() {
              throw new Error('trap');
            },
          },
        ),
    ],
  ];

  describe.each(hostileErrors)('%s', (_label, error) => {
    it.each(['throw', 'throw_sync'] as const)(
      'gives the safe value with FLAG_GENERAL when the provider uses %s',
      async (kind) => {
        const client = await boot(
          new FakeProvider()
            .set(RELEASE, { kind, error: error() })
            .set(KILL_SAFE_ON, { kind, error: error() }),
        );
        expect(await settle(client.evaluate(RELEASE, ctx))).toEqual({
          value: false,
          source: 'safe_value',
          errorCode: 'FLAG_GENERAL',
        });
        expect(await settle(client.isOn(KILL_SAFE_ON, ctx))).toBe(true);
      },
    );
  });
});

describe('a domain that no longer points at the client provider', () => {
  afterEach(async () => {
    await OpenFeature.clearProviders();
  });

  it.each<[string, (domain: string, other: FakeProvider) => Promise<void>]>([
    [
      'cleared, with a ready default provider',
      async (_domain, other) => {
        await OpenFeature.clearProviders();
        await OpenFeature.setProviderAndWait(other);
      },
    ],
    [
      'rebound to another ready provider',
      async (domain, other) => {
        await OpenFeature.setProviderAndWait(domain, other);
      },
    ],
  ])('fails closed when %s', async (_label, rebind) => {
    const getClient = vi.spyOn(OpenFeature, 'getClient');
    const fake = new FakeProvider()
      .set(RELEASE, { kind: 'value', value: true })
      .set(KILL_SAFE_ON, { kind: 'value', value: false });
    const client = await boot(fake);
    const domain = getClient.mock.calls[0]?.[0];
    if (typeof domain !== 'string') throw new Error('the client was not built for a domain');
    const other = new FakeProvider().setAll({ kind: 'value', value: true });
    await rebind(domain, other);
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
    expect(other.calls).toHaveLength(0);
  });
});

describe('an entitlements reader that throws synchronously', () => {
  it('turns the plan flag off with FLAG_GENERAL', async () => {
    const reader = {
      hasFeature: () => {
        throw new Error('not async');
      },
    };
    const client = await boot(new FakeProvider(), { entitlements: reader });
    expect(await settle(client.evaluate(PLAN, ctx))).toEqual({
      value: false,
      source: 'safe_value',
      errorCode: 'FLAG_GENERAL',
    });
  });
});

describe('after close', () => {
  it('plan flags answer off without asking entitlements', async () => {
    const ent = entitlements(() => Promise.resolve(true));
    const client = await boot(new FakeProvider(), { entitlements: ent.reader });
    await client.close();
    const result = await settle(client.evaluate(PLAN, ctx));
    expect(result.value).toBe(false);
    expect(result.source).toBe('safe_value');
    expect(ent.hasFeature).not.toHaveBeenCalled();
  });
});

describe('sinks that throw', () => {
  it('break neither the start nor an evaluation', async () => {
    const boom = () => {
      throw new Error('sink down');
    };
    // A failed start logs, so the throwing logger is exercised too.
    const fake = new FakeProvider('reject').set(RELEASE, { kind: 'value', value: true });
    const client = await boot(fake, {
      logger: { warn: boom },
      metrics: { gauge: boom, histogram: boom },
    });
    expect((await settle(client.evaluate(RELEASE, ctx))).value).toBe(false);
    fake.emit(ProviderEvents.Ready);
    await vi.advanceTimersByTimeAsync(0);
    expect(await settle(client.evaluate(RELEASE, ctx))).toEqual({
      value: true,
      source: 'provider',
    });
  });
});

describe('the test client', () => {
  it('answers a name outside its registry with FLAG_NOT_FOUND', async () => {
    const client = createTestFlagClient(undefined, { env: {}, registry: fixtureFlags });
    const name = 'product.website' as unknown as typeof RELEASE;
    expect(await client.evaluate(name, ctx)).toEqual({
      value: false,
      source: 'safe_value',
      errorCode: 'FLAG_NOT_FOUND',
    });
    await client.close();
  });

  it('answers a plan flag without an override as off', async () => {
    const client = createTestFlagClient(undefined, { env: {}, registry: fixtureFlags });
    expect(await client.evaluate(PLAN, ctx)).toEqual({ value: false, source: 'safe_value' });
    await client.close();
  });

  it('refuses an override that is not a boolean', () => {
    expect(() =>
      createTestFlagClient(
        { [RELEASE]: 'yes' as unknown as boolean },
        { env: {}, registry: fixtureFlags },
      ),
    ).toThrow(expect.objectContaining({ code: 'FLAG_DEFINITION_INVALID', flag: RELEASE }));
  });
});
