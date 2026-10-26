import {
  ErrorCode,
  FlagNotFoundError,
  GeneralError,
  OpenFeature,
  ParseError,
  ProviderEvents,
  TypeMismatchError,
} from '@openfeature/server-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFlagClient,
  flags,
  type FlagClient,
  type FlagClientDeps,
  type FlagConfig,
  type FlagEvaluationErrorCode,
} from '../src/index.ts';
import { FakeProvider, type Behaviour } from './support/fake-provider.ts';
import { install, reset } from './support/flagd.ts';
import {
  EXPERIMENT,
  KILL_SAFE_OFF,
  KILL_SAFE_ON,
  ORG,
  OTHER_ORG,
  PLAN,
  PROJECT,
  RELEASE,
  USER,
  ctx,
  entitlements,
  fileConfig,
  fixtureFlags,
  fullCtx,
  recorders,
  settle,
} from './support/fixtures.ts';

vi.mock('@openfeature/flagd-provider', () => import('./support/flagd.ts'));

type Fixture = typeof fixtureFlags;
type Client = FlagClient<Fixture>;

const open: { close(): Promise<void> }[] = [];

async function boot(
  fake: FakeProvider,
  deps: Partial<FlagClientDeps<Fixture>> = {},
  config: FlagConfig = fileConfig,
): Promise<Client> {
  install(fake);
  const client = await createFlagClient(config, {
    entitlements: entitlements().reader,
    registry: fixtureFlags,
    ...deps,
  });
  open.push(client);
  return client;
}

// Boots against a provider whose start never finishes, moving the clock past the wait.
async function bootUnready(
  fake: FakeProvider,
  deps: Partial<FlagClientDeps<Fixture>> = {},
  config: FlagConfig = fileConfig,
): Promise<Client> {
  install(fake);
  const pending = createFlagClient(config, {
    entitlements: entitlements().reader,
    registry: fixtureFlags,
    ...deps,
  });
  await vi.advanceTimersByTimeAsync(config.initTimeoutMs);
  const client = await pending;
  open.push(client);
  return client;
}

beforeEach(() => {
  vi.useFakeTimers();
  reset();
});

afterEach(async () => {
  for (const client of open.splice(0)) await client.close();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const PROVIDER_FLAGS = [
  [RELEASE, false],
  [KILL_SAFE_ON, true],
  [KILL_SAFE_OFF, false],
  [EXPERIMENT, false],
] as const;

// Each failure the provider can produce, the code the client must report, and a value
// the provider offers that would be wrong to use. `unsafe` flips per flag below.
const FAILURES: [string, (unsafe: boolean) => Behaviour, FlagEvaluationErrorCode][] = [
  ['throws an Error', () => ({ kind: 'throw', error: new Error('boom') }), 'FLAG_GENERAL'],
  [
    'throws synchronously',
    () => ({ kind: 'throw_sync', error: new Error('boom') }),
    'FLAG_GENERAL',
  ],
  ['throws a string', () => ({ kind: 'throw', error: 'boom' }), 'FLAG_GENERAL'],
  ['throws undefined', () => ({ kind: 'throw', error: undefined }), 'FLAG_GENERAL'],
  ['throws GeneralError', () => ({ kind: 'throw', error: new GeneralError('x') }), 'FLAG_GENERAL'],
  [
    'throws FlagNotFoundError',
    () => ({ kind: 'throw', error: new FlagNotFoundError('x') }),
    'FLAG_NOT_FOUND',
  ],
  ['throws ParseError', () => ({ kind: 'throw', error: new ParseError('x') }), 'FLAG_PARSE_ERROR'],
  [
    'throws TypeMismatchError',
    () => ({ kind: 'throw', error: new TypeMismatchError('x') }),
    'FLAG_PARSE_ERROR',
  ],
  [
    'reports FLAG_NOT_FOUND with a value',
    (unsafe) => ({ kind: 'error_result', errorCode: ErrorCode.FLAG_NOT_FOUND, value: unsafe }),
    'FLAG_NOT_FOUND',
  ],
  [
    'reports PARSE_ERROR with a value',
    (unsafe) => ({ kind: 'error_result', errorCode: ErrorCode.PARSE_ERROR, value: unsafe }),
    'FLAG_PARSE_ERROR',
  ],
  [
    'reports TYPE_MISMATCH with a value',
    (unsafe) => ({ kind: 'error_result', errorCode: ErrorCode.TYPE_MISMATCH, value: unsafe }),
    'FLAG_PARSE_ERROR',
  ],
  [
    'reports GENERAL with a value',
    (unsafe) => ({ kind: 'error_result', errorCode: ErrorCode.GENERAL, value: unsafe }),
    'FLAG_GENERAL',
  ],
  [
    'reports PROVIDER_NOT_READY with a value',
    (unsafe) => ({ kind: 'error_result', errorCode: ErrorCode.PROVIDER_NOT_READY, value: unsafe }),
    'FLAG_PROVIDER_NOT_READY',
  ],
  // The server SDK passes a provider's value through without checking its type.
  ['returns the string "true"', () => ({ kind: 'value', value: 'true' }), 'FLAG_PARSE_ERROR'],
  ['returns the string "false"', () => ({ kind: 'value', value: 'false' }), 'FLAG_PARSE_ERROR'],
  ['returns the string "on"', () => ({ kind: 'value', value: 'on' }), 'FLAG_PARSE_ERROR'],
  ['returns 1', () => ({ kind: 'value', value: 1 }), 'FLAG_PARSE_ERROR'],
  ['returns 0', () => ({ kind: 'value', value: 0 }), 'FLAG_PARSE_ERROR'],
  ['returns null', () => ({ kind: 'value', value: null }), 'FLAG_PARSE_ERROR'],
  ['returns undefined', () => ({ kind: 'value', value: undefined }), 'FLAG_PARSE_ERROR'],
  ['returns an object', () => ({ kind: 'value', value: { on: true } }), 'FLAG_PARSE_ERROR'],
  ['returns an array', () => ({ kind: 'value', value: [true] }), 'FLAG_PARSE_ERROR'],
];

describe('provider failures give the safe value', () => {
  describe.each(PROVIDER_FLAGS)('%s (safe value %s)', (name, safe) => {
    it.each(FAILURES)('when the provider %s', async (_label, behaviour, code) => {
      const fake = new FakeProvider().set(name, behaviour(!safe));
      const client = await boot(fake);
      const result = await settle(client.evaluate(name, ctx));
      expect(result).toEqual({ value: safe, source: 'safe_value', errorCode: code });
      expect(await settle(client.isOn(name, ctx))).toBe(safe);
    });

    it('when the provider has failed for good (PROVIDER_FATAL)', async () => {
      const fake = new FakeProvider().set(name, { kind: 'value', value: !safe });
      const client = await boot(fake);
      fake.emit(ProviderEvents.Error, ErrorCode.PROVIDER_FATAL);
      const result = await settle(client.evaluate(name, ctx));
      expect(result.value).toBe(safe);
      expect(result.source).toBe('safe_value');
      expect(result.errorCode).toBeDefined();
    });
  });

  it('never turns a release flag on from a provider error that carries true', async () => {
    const fake = new FakeProvider().setAll({
      kind: 'error_result',
      errorCode: ErrorCode.GENERAL,
      value: true,
    });
    const client = await boot(fake);
    expect(await settle(client.isOn(RELEASE, ctx))).toBe(false);
  });
});

describe('provider answers', () => {
  describe.each(PROVIDER_FLAGS)('%s', (name) => {
    it.each([true, false])('serves %s from the provider', async (value) => {
      const client = await boot(new FakeProvider().set(name, { kind: 'value', value }));
      expect(await client.evaluate(name, ctx)).toEqual({ value, source: 'provider' });
      expect(await client.isOn(name, ctx)).toBe(value);
    });
  });

  it('does not report an error code on success', async () => {
    const client = await boot(new FakeProvider().set(RELEASE, { kind: 'value', value: true }));
    expect(await client.evaluate(RELEASE, ctx)).not.toHaveProperty('errorCode');
  });

  it('works with a provider that has no initialize step', async () => {
    const client = await boot(
      new FakeProvider('none').set(RELEASE, { kind: 'value', value: true }),
    );
    expect(await client.evaluate(RELEASE, ctx)).toEqual({ value: true, source: 'provider' });
  });
});

describe('the wrapper timeout', () => {
  it('returns the safe value with FLAG_TIMEOUT at 50 ms when the provider never answers', async () => {
    const client = await boot(new FakeProvider().set(RELEASE, { kind: 'hang' }));
    let settled = false;
    const pending = client.evaluate(RELEASE, ctx).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await pending).toEqual({
      value: false,
      source: 'safe_value',
      errorCode: 'FLAG_TIMEOUT',
    });
  });

  it.each([
    [KILL_SAFE_ON, true],
    [KILL_SAFE_OFF, false],
  ] as const)('gives kill switch %s its safe value %s on timeout', async (name, safe) => {
    const client = await boot(new FakeProvider().set(name, { kind: 'hang' }));
    expect(await settle(client.evaluate(name, ctx))).toEqual({
      value: safe,
      source: 'safe_value',
      errorCode: 'FLAG_TIMEOUT',
    });
    expect(await settle(client.isOn(name, ctx))).toBe(safe);
  });

  it('ignores an answer that arrives after the timeout', async () => {
    const client = await boot(
      new FakeProvider().set(RELEASE, { kind: 'late_value', afterMs: 51, value: true }),
    );
    const result = await settle(client.evaluate(RELEASE, ctx));
    await vi.advanceTimersByTimeAsync(100);
    expect(result).toEqual({ value: false, source: 'safe_value', errorCode: 'FLAG_TIMEOUT' });
  });

  it('uses an answer that arrives just inside the timeout', async () => {
    const client = await boot(
      new FakeProvider().set(KILL_SAFE_ON, { kind: 'late_value', afterMs: 49, value: false }),
    );
    expect(await settle(client.evaluate(KILL_SAFE_ON, ctx))).toEqual({
      value: false,
      source: 'provider',
    });
  });

  it('swallows a rejection that arrives after the timeout', async () => {
    // An unhandled rejection fails the run, so this test fails if the late error leaks.
    const client = await boot(
      new FakeProvider().set(RELEASE, {
        kind: 'late_throw',
        afterMs: 80,
        error: new Error('late'),
      }),
    );
    expect((await settle(client.evaluate(RELEASE, ctx))).errorCode).toBe('FLAG_TIMEOUT');
    await vi.advanceTimersByTimeAsync(100);
  });

  it('follows DREFYN_FLAGS_EVAL_TIMEOUT_MS', async () => {
    const client = await boot(
      new FakeProvider().set(RELEASE, { kind: 'hang' }),
      {},
      {
        ...fileConfig,
        evalTimeoutMs: 10,
      },
    );
    let settled = false;
    const pending = client.evaluate(RELEASE, ctx).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(9);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).errorCode).toBe('FLAG_TIMEOUT');
  });

  it('times out every concurrent call on a hung provider, then leaves no timer behind', async () => {
    const client = await boot(new FakeProvider().setAll({ kind: 'hang' }));
    const before = vi.getTimerCount();
    const pending = Array.from({ length: 100 }, (_, i) =>
      client.evaluate(i % 2 === 0 ? RELEASE : KILL_SAFE_ON, ctx),
    );
    const results = await settle(Promise.all(pending));
    expect(results.filter((r) => r.errorCode === 'FLAG_TIMEOUT')).toHaveLength(100);
    expect(results.filter((r, i) => r.value !== (i % 2 === 1))).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(before);
  });

  it('clears its timer when the provider answers first', async () => {
    const client = await boot(new FakeProvider().set(RELEASE, { kind: 'value', value: false }));
    const before = vi.getTimerCount();
    await client.evaluate(RELEASE, ctx);
    await client.isOn(RELEASE, ctx);
    expect(vi.getTimerCount()).toBe(before);
  });
});

describe('every evaluation passes the safe value as the OpenFeature default', () => {
  // Records the default handed to any boolean method of any OpenFeature client the
  // package creates, whichever of getBooleanValue or getBooleanDetails it uses.
  function spyOnClients() {
    const calls: { method: string; flagKey: unknown; defaultValue: unknown }[] = [];
    const getClient = OpenFeature.getClient.bind(OpenFeature) as (...args: unknown[]) => object;
    vi.spyOn(OpenFeature, 'getClient').mockImplementation(((...args: unknown[]) => {
      const client = getClient(...args);
      return new Proxy(client, {
        get(target, prop) {
          const value: unknown = Reflect.get(target, prop, target);
          if (typeof value !== 'function') return value;
          const fn = value as (...a: unknown[]) => unknown;
          if (typeof prop === 'string' && prop.startsWith('getBoolean')) {
            return (...a: unknown[]) => {
              calls.push({ method: prop, flagKey: a[0], defaultValue: a[1] });
              return fn.apply(target, a);
            };
          }
          return fn.bind(target);
        },
      });
    }) as unknown as typeof OpenFeature.getClient);
    return calls;
  }

  it('for every flag in a registry with each kind and both kill switch polarities', async () => {
    const calls = spyOnClients();
    // The provider answers the opposite of the safe value, so a missing default shows.
    const fake = new FakeProvider();
    for (const [name, safe] of PROVIDER_FLAGS) fake.set(name, { kind: 'value', value: !safe });
    const client = await boot(fake);
    for (const [name, safe] of PROVIDER_FLAGS) {
      await client.evaluate(name, ctx);
      await client.isOn(name, ctx);
      const atProvider = fake.callsFor(name);
      expect(atProvider, name).toHaveLength(2);
      for (const call of atProvider) expect(call.defaultValue, name).toBe(safe);
      const atClient = calls.filter((c) => c.flagKey === name);
      expect(atClient, name).toHaveLength(2);
      for (const call of atClient) expect(call.defaultValue, name).toBe(safe);
    }
  });

  it('for every flag in the package registry', async () => {
    const calls = spyOnClients();
    const fake = new FakeProvider().setAll({ kind: 'value', value: true });
    install(fake);
    const client = await createFlagClient(fileConfig, { entitlements: entitlements().reader });
    open.push(client);
    const providerFlags = flags.filter((flag) => (flag.kind as string) !== 'plan');
    expect(providerFlags.length).toBeGreaterThanOrEqual(3);
    for (const flag of providerFlags) {
      await client.evaluate(flag.name, ctx);
      const expected = 'safeValue' in flag ? flag.safeValue : undefined;
      expect(fake.callsFor(flag.name).map((c) => c.defaultValue)).toEqual([expected]);
      expect(calls.filter((c) => c.flagKey === flag.name).map((c) => c.defaultValue)).toEqual([
        expected,
      ]);
    }
  });
});

describe('after the provider loses its connection', () => {
  // The in process provider keeps its last synced values and keeps answering from them;
  // the client must not treat the provider's stale or error state as a failure.
  it.each([ProviderEvents.Stale, ProviderEvents.Error])(
    'keeps serving the last synced values after %s',
    async (event) => {
      const fake = new FakeProvider()
        .set(KILL_SAFE_ON, { kind: 'value', value: false })
        .set(RELEASE, { kind: 'value', value: true });
      const client = await boot(fake);
      expect(await client.evaluate(KILL_SAFE_ON, ctx)).toEqual({
        value: false,
        source: 'provider',
      });

      fake.emit(event);
      fake
        .set(KILL_SAFE_ON, { kind: 'value', value: false, reason: 'CACHED' })
        .set(RELEASE, { kind: 'value', value: true, reason: 'CACHED' });

      expect(await client.evaluate(KILL_SAFE_ON, ctx)).toEqual({
        value: false,
        source: 'provider',
      });
      expect(await client.evaluate(RELEASE, ctx)).toEqual({ value: true, source: 'provider' });
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(await client.isOn(KILL_SAFE_ON, ctx)).toBe(false);
    },
  );

  it('picks up new values once the provider reconnects', async () => {
    const fake = new FakeProvider().set(KILL_SAFE_ON, { kind: 'value', value: true });
    const client = await boot(fake);
    fake.emit(ProviderEvents.Error);
    fake.set(KILL_SAFE_ON, { kind: 'value', value: false });
    fake.emit(ProviderEvents.Ready);
    fake.emit(ProviderEvents.ConfigurationChanged);
    expect(await client.evaluate(KILL_SAFE_ON, ctx)).toEqual({ value: false, source: 'provider' });
  });
});

describe('when the provider is unreachable at start', () => {
  it('resolves after the init wait, not before, and does not throw', async () => {
    install(new FakeProvider('hang'));
    let resolved = false;
    const pending = createFlagClient(fileConfig, {
      entitlements: entitlements().reader,
      registry: fixtureFlags,
    }).then((client) => {
      resolved = true;
      open.push(client);
      return client;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
    await expect(pending).resolves.toBeDefined();
  });

  it('follows DREFYN_FLAGS_INIT_TIMEOUT_MS', async () => {
    install(new FakeProvider('hang'));
    let resolved = false;
    void createFlagClient(
      { ...fileConfig, initTimeoutMs: 100 },
      { entitlements: entitlements().reader, registry: fixtureFlags },
    ).then((client) => {
      resolved = true;
      open.push(client);
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
  });

  it('logs flags.provider_not_ready once and reports the provider as not ready', async () => {
    const rec = recorders();
    const client = await bootUnready(new FakeProvider('hang'), rec);
    await settle(client.evaluate(RELEASE, ctx));
    await settle(client.evaluate(KILL_SAFE_ON, ctx));
    const events = rec.warn.mock.calls.map(([event]) => event);
    expect(events.filter((e) => e === 'flags.provider_not_ready')).toHaveLength(1);
    const ready = rec.gauge.mock.calls.filter(([name]) => name === 'flags_provider_ready');
    expect(ready.at(-1)?.[1]).toBe(0);
  });

  it.each(PROVIDER_FLAGS)(
    'serves %s its safe value %s with FLAG_PROVIDER_NOT_READY',
    async (name, safe) => {
      const client = await bootUnready(new FakeProvider('hang'));
      expect(await settle(client.evaluate(name, ctx))).toEqual({
        value: safe,
        source: 'safe_value',
        errorCode: 'FLAG_PROVIDER_NOT_READY',
      });
      expect(await settle(client.isOn(name, ctx))).toBe(safe);
    },
  );

  it('switches to provider values once the provider becomes ready', async () => {
    const rec = recorders();
    const fake = new FakeProvider('hang').set(RELEASE, { kind: 'value', value: true });
    const client = await bootUnready(fake, rec);
    expect((await settle(client.evaluate(RELEASE, ctx))).value).toBe(false);
    fake.finishInit();
    await vi.advanceTimersByTimeAsync(0);
    expect(await client.evaluate(RELEASE, ctx)).toEqual({ value: true, source: 'provider' });
    const ready = rec.gauge.mock.calls.filter(([name]) => name === 'flags_provider_ready');
    expect(ready.at(-1)?.[1]).toBe(1);
  });

  it('resolves and serves safe values when the provider start fails outright', async () => {
    const rec = recorders();
    install(
      new FakeProvider('reject').setAll({ kind: 'throw', error: new FlagNotFoundError('x') }),
    );
    const pending = createFlagClient(fileConfig, {
      entitlements: entitlements().reader,
      registry: fixtureFlags,
      ...rec,
    });
    await vi.advanceTimersByTimeAsync(fileConfig.initTimeoutMs);
    const client = await pending;
    open.push(client);
    expect(rec.warn.mock.calls.map(([event]) => event)).toContain('flags.provider_not_ready');
    for (const [name, safe] of PROVIDER_FLAGS) {
      const result = await settle(client.evaluate(name, ctx));
      expect(result.value, name).toBe(safe);
      expect(result.source, name).toBe('safe_value');
      expect(result.errorCode, name).toBeDefined();
    }
  });
});

describe('plan flags', () => {
  it('read entitlements and never the provider', async () => {
    const ent = entitlements((feature) => Promise.resolve(feature === 'docs.versioning'));
    const fake = new FakeProvider().setAll({ kind: 'value', value: false });
    const client = await boot(fake, { entitlements: ent.reader });
    expect(await client.evaluate(PLAN, ctx)).toEqual({ value: true, source: 'entitlements' });
    expect(ent.hasFeature).toHaveBeenCalledTimes(1);
    expect(ent.hasFeature).toHaveBeenCalledWith(ORG, 'docs.versioning');
    expect(fake.callsFor(PLAN)).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
  });

  it('pass the organization of the context, not another one', async () => {
    const ent = entitlements(() => Promise.resolve(false));
    const client = await boot(new FakeProvider(), { entitlements: ent.reader });
    await client.evaluate(PLAN, { organizationId: OTHER_ORG });
    expect(ent.hasFeature).toHaveBeenCalledWith(OTHER_ORG, 'docs.versioning');
  });

  it('answer false from entitlements as false', async () => {
    const ent = entitlements(() => Promise.resolve(false));
    const client = await boot(new FakeProvider(), { entitlements: ent.reader });
    expect(await client.evaluate(PLAN, ctx)).toEqual({ value: false, source: 'entitlements' });
  });

  it('work while the provider is not ready', async () => {
    const ent = entitlements(() => Promise.resolve(true));
    const fake = new FakeProvider('hang');
    const client = await bootUnready(fake, { entitlements: ent.reader });
    expect(await client.evaluate(PLAN, ctx)).toEqual({ value: true, source: 'entitlements' });
    expect(fake.calls).toHaveLength(0);
  });

  it('fail closed when entitlements throws', async () => {
    const ent = entitlements(() => Promise.reject(new Error('db down')));
    const client = await boot(new FakeProvider(), { entitlements: ent.reader });
    expect(await settle(client.evaluate(PLAN, ctx))).toEqual({
      value: false,
      source: 'safe_value',
      errorCode: 'FLAG_GENERAL',
    });
  });

  it('fail closed with FLAG_TIMEOUT when entitlements hangs', async () => {
    const ent = entitlements(() => new Promise<boolean>(() => undefined));
    const client = await boot(new FakeProvider(), { entitlements: ent.reader });
    expect(await settle(client.evaluate(PLAN, ctx))).toEqual({
      value: false,
      source: 'safe_value',
      errorCode: 'FLAG_TIMEOUT',
    });
  });

  it('fail closed when entitlements answers something other than a boolean', async () => {
    const ent = entitlements(() => Promise.resolve('yes' as unknown as boolean));
    const client = await boot(new FakeProvider(), { entitlements: ent.reader });
    expect(await settle(client.evaluate(PLAN, ctx))).toEqual({
      value: false,
      source: 'safe_value',
      errorCode: 'FLAG_PARSE_ERROR',
    });
  });
});

describe('the production client and DREFYN_RELEASE_FLAGS', () => {
  it.each(['on', 'off'])(
    'with %s, release flags still come only from the provider',
    async (value) => {
      vi.stubEnv('DREFYN_RELEASE_FLAGS', value);
      const fake = new FakeProvider()
        .set(RELEASE, { kind: 'value', value: false })
        .set(EXPERIMENT, { kind: 'hang' });
      const client = await boot(fake);
      expect(await client.evaluate(RELEASE, ctx)).toEqual({ value: false, source: 'provider' });
      expect(await settle(client.evaluate(EXPERIMENT, ctx))).toEqual({
        value: false,
        source: 'safe_value',
        errorCode: 'FLAG_TIMEOUT',
      });
    },
  );

  it('with on and no provider, release flags are off', async () => {
    vi.stubEnv('DREFYN_RELEASE_FLAGS', 'on');
    const client = await bootUnready(new FakeProvider('hang'));
    expect(await settle(client.isOn(RELEASE, ctx))).toBe(false);
  });

  it('with off, a provider that turns a release flag on is still obeyed', async () => {
    vi.stubEnv('DREFYN_RELEASE_FLAGS', 'off');
    const client = await boot(new FakeProvider().set(RELEASE, { kind: 'value', value: true }));
    expect(await client.isOn(RELEASE, ctx)).toBe(true);
  });
});

describe('evaluation context', () => {
  it('uses the organization as the targeting key and passes the rollout fields', async () => {
    const fake = new FakeProvider().set(RELEASE, { kind: 'value', value: false });
    const client = await boot(fake);
    await client.evaluate(RELEASE, fullCtx);
    const [call] = fake.callsFor(RELEASE);
    expect(call?.context).toMatchObject({
      targetingKey: ORG,
      organizationId: ORG,
      projectId: PROJECT,
      internal: true,
    });
  });

  it('does not leak one call context into the next', async () => {
    const fake = new FakeProvider().set(RELEASE, { kind: 'value', value: false });
    const client = await boot(fake);
    await client.evaluate(RELEASE, fullCtx);
    await client.evaluate(RELEASE, { organizationId: OTHER_ORG });
    const second = fake.callsFor(RELEASE)[1]?.context;
    expect(second).toMatchObject({ targetingKey: OTHER_ORG });
    expect(second).not.toHaveProperty('projectId');
    expect(second).not.toHaveProperty('internal');
  });
});

describe('names outside the registry', () => {
  it('give false with FLAG_NOT_FOUND and never reach the provider', async () => {
    const fake = new FakeProvider().setAll({ kind: 'value', value: true });
    const client = await boot(fake);
    const name = 'product.website' as unknown as typeof RELEASE;
    expect(await settle(client.evaluate(name, ctx))).toEqual({
      value: false,
      source: 'safe_value',
      errorCode: 'FLAG_NOT_FOUND',
    });
    expect(await settle(client.isOn(name, ctx))).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it.each(['__proto__', 'constructor', 'toString'])('%j is not found either', async (name) => {
    const client = await boot(new FakeProvider().setAll({ kind: 'value', value: true }));
    const result = await settle(client.evaluate(name as unknown as typeof RELEASE, ctx));
    expect(result).toEqual({ value: false, source: 'safe_value', errorCode: 'FLAG_NOT_FOUND' });
  });
});

describe('two clients in one process', () => {
  it('each read their own provider', async () => {
    const a = new FakeProvider().set(KILL_SAFE_ON, { kind: 'value', value: false });
    const b = new FakeProvider().set(KILL_SAFE_ON, { kind: 'value', value: true });
    const first = await boot(a);
    const second = await boot(b);
    expect(await first.evaluate(KILL_SAFE_ON, ctx)).toEqual({ value: false, source: 'provider' });
    expect(await second.evaluate(KILL_SAFE_ON, ctx)).toEqual({ value: true, source: 'provider' });
  });

  it('closing one leaves the other running', async () => {
    const a = new FakeProvider();
    const b = new FakeProvider().set(KILL_SAFE_ON, { kind: 'value', value: false });
    const first = await boot(a);
    const second = await boot(b);
    await first.close();
    expect(a.closed).toBe(1);
    expect(b.closed).toBe(0);
    expect(await second.evaluate(KILL_SAFE_ON, ctx)).toEqual({ value: false, source: 'provider' });
  });
});

describe('close', () => {
  it('closes the provider once, however often it is called', async () => {
    const fake = new FakeProvider();
    const client = await boot(fake);
    await client.close();
    await client.close();
    expect(fake.closed).toBe(1);
  });

  it('leaves later evaluations answering safe values instead of throwing', async () => {
    const fake = new FakeProvider().set(KILL_SAFE_ON, { kind: 'value', value: false });
    const client = await boot(fake);
    await client.close();
    const result = await settle(client.evaluate(KILL_SAFE_ON, ctx));
    expect(result.value).toBe(true);
    expect(result.source).toBe('safe_value');
  });
});

describe('metrics and logs', () => {
  it('report the provider ready after a normal start', async () => {
    const rec = recorders();
    await boot(new FakeProvider(), rec);
    const ready = rec.gauge.mock.calls.filter(([name]) => name === 'flags_provider_ready');
    expect(ready.at(-1)?.[1]).toBe(1);
  });

  it('time every evaluation, failures and plan flags included', async () => {
    const rec = recorders();
    const fake = new FakeProvider()
      .set(RELEASE, { kind: 'value', value: true })
      .set(KILL_SAFE_ON, { kind: 'hang' })
      .set(EXPERIMENT, { kind: 'throw', error: new Error('x') });
    const client = await boot(fake, rec);
    await client.evaluate(RELEASE, ctx);
    await settle(client.evaluate(KILL_SAFE_ON, ctx));
    await settle(client.evaluate(EXPERIMENT, ctx));
    await client.evaluate(PLAN, ctx);
    await client.isOn(RELEASE, ctx);
    const timings = rec.histogram.mock.calls;
    expect(timings).toHaveLength(5);
    for (const [, ms] of timings) {
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(0);
    }
  });

  // Tenant IDs belong in log context but not in metric labels, where every organization
  // would become its own series. User IDs are personal data and go in neither.
  it('keep tenant and user IDs out of metric labels and user IDs out of logs', async () => {
    const rec = recorders();
    const fake = new FakeProvider('hang').setAll({ kind: 'throw', error: new Error('x') });
    const client = await bootUnready(fake, rec);
    await settle(client.evaluate(RELEASE, fullCtx));
    fake.finishInit();
    await vi.advanceTimersByTimeAsync(0);
    await settle(client.evaluate(KILL_SAFE_ON, fullCtx));
    await settle(client.evaluate(PLAN, fullCtx));
    expect(rec.histogram).toHaveBeenCalled();
    const metrics = JSON.stringify([rec.gauge.mock.calls, rec.histogram.mock.calls]);
    for (const id of [ORG, PROJECT, USER]) expect(metrics).not.toContain(id);
    expect(JSON.stringify(rec.warn.mock.calls)).not.toContain(USER);
  });
});
