// Failures outside the provider: the SDK client itself, the injected sinks and the
// entitlements reader can all misbehave, and none of them may break an evaluation.
import { OpenFeature, ProviderEvents } from '@openfeature/server-sdk';
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

// Makes every OpenFeature client the package creates answer boolean calls with `answer`.
function breakSdkClients(answer: () => unknown) {
  const getClient = OpenFeature.getClient.bind(OpenFeature) as (...args: unknown[]) => object;
  vi.spyOn(OpenFeature, 'getClient').mockImplementation(((...args: unknown[]) => {
    const client = getClient(...args);
    return new Proxy(client, {
      get(target, prop) {
        if (prop === 'getBooleanDetails') return answer;
        const value: unknown = Reflect.get(target, prop, target);
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
});

describe('an SDK client that misbehaves', () => {
  it('keeps a release flag off when it throws synchronously', async () => {
    breakSdkClients(() => {
      throw new Error('sdk bug');
    });
    const client = await boot(new FakeProvider().set(RELEASE, { kind: 'value', value: true }));
    expect(await settle(client.evaluate(RELEASE, ctx))).toEqual({
      value: false,
      source: 'safe_value',
      errorCode: 'FLAG_GENERAL',
    });
    expect(await settle(client.isOn(RELEASE, ctx))).toBe(false);
  });

  it('gives the safe value with FLAG_GENERAL when it throws synchronously', async () => {
    breakSdkClients(() => {
      throw new Error('sdk bug');
    });
    const client = await boot(
      new FakeProvider().set(KILL_SAFE_ON, { kind: 'value', value: false }),
    );
    expect(await settle(client.evaluate(KILL_SAFE_ON, ctx))).toEqual({
      value: true,
      source: 'safe_value',
      errorCode: 'FLAG_GENERAL',
    });
  });

  it('gives the safe value with FLAG_GENERAL when it rejects', async () => {
    breakSdkClients(() => Promise.reject(new Error('sdk bug')));
    const client = await boot(new FakeProvider().set(RELEASE, { kind: 'value', value: true }));
    expect(await settle(client.evaluate(RELEASE, ctx))).toEqual({
      value: false,
      source: 'safe_value',
      errorCode: 'FLAG_GENERAL',
    });
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
