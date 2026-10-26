import {
  AsyncLocalStorageTransactionContextPropagator,
  ErrorCode,
  FlagNotFoundError,
  NOOP_TRANSACTION_CONTEXT_PROPAGATOR,
  GeneralError,
  OpenFeature,
  ParseError,
  ProviderEvents,
  TypeMismatchError,
  type Client as OpenFeatureClient,
  type EvaluationContext,
  type Hook,
} from '@openfeature/server-sdk';
import fc from 'fast-check';
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
import { PROVIDER_PROPERTY_TIMEOUT_MS, SEEDS } from './support/seeds.ts';
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

describe('every evaluation passes the safe value as the provider default', () => {
  // Records any boolean method called on any OpenFeature client the package creates. None
  // should be: those run hooks, so the client goes to its provider directly.
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
    }
    expect(calls).toEqual([]);
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
    }
    expect(calls).toEqual([]);
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
    // Always sent, so a global OpenFeature context cannot fill it in.
    expect(second).toMatchObject({ internal: false });
  });

  // Keys the caller never set, such as plan, must not reach a targeting rule either.
  const OUTSIDE = {
    internal: true,
    targetingKey: 'someone-else',
    organizationId: 'someone-else',
    plan: 'enterprise',
    projectId: 'someone-else',
  };
  const EXACT = { targetingKey: OTHER_ORG, organizationId: OTHER_ORG, internal: false };

  it('leaves the global OpenFeature context out entirely', async () => {
    OpenFeature.setContext(OUTSIDE);
    try {
      const fake = new FakeProvider().set(RELEASE, { kind: 'value', value: false });
      const client = await boot(fake);
      await client.evaluate(RELEASE, { organizationId: OTHER_ORG });
      await client.evaluate(RELEASE, { organizationId: OTHER_ORG, internal: false });
      expect(fake.callsFor(RELEASE).map((call) => call.context)).toEqual([EXACT, EXACT]);
    } finally {
      OpenFeature.setContext({});
    }
  });

  it('leaves the transaction context out entirely', async () => {
    OpenFeature.setTransactionContextPropagator(
      new AsyncLocalStorageTransactionContextPropagator(),
    );
    try {
      const fake = new FakeProvider().set(RELEASE, { kind: 'value', value: false });
      const client = await boot(fake);
      await new Promise<void>((resolve, reject) => {
        OpenFeature.setTransactionContext(OUTSIDE, () => {
          // Proves the propagator really carries the context inside the callback.
          expect(OpenFeature.getTransactionContext()).toEqual(OUTSIDE);
          client.evaluate(RELEASE, { organizationId: OTHER_ORG }).then(() => {
            resolve();
          }, reject);
        });
      });
      expect(fake.callsFor(RELEASE).map((call) => call.context)).toEqual([EXACT]);
    } finally {
      OpenFeature.setTransactionContextPropagator(NOOP_TRANSACTION_CONTEXT_PROPAGATOR);
    }
  });
});

describe('provider results of the wrong shape', () => {
  const throwingValue = () =>
    Object.defineProperty({}, 'value', {
      get() {
        throw new Error('getter');
      },
    });
  it.each<[string, () => unknown, FlagEvaluationErrorCode]>([
    ['undefined', () => undefined, 'FLAG_PARSE_ERROR'],
    ['null', () => null, 'FLAG_PARSE_ERROR'],
    ['the string true', () => 'true', 'FLAG_PARSE_ERROR'],
    ['true itself', () => true, 'FLAG_PARSE_ERROR'],
    ['an empty error code', () => ({ value: true, errorCode: '' }), 'FLAG_GENERAL'],
    ['an unknown error code', () => ({ value: true, errorCode: 'NOPE' }), 'FLAG_GENERAL'],
    ['a value getter that throws', throwingValue, 'FLAG_GENERAL'],
  ])('give the safe value for %s', async (_label, resolution, code) => {
    const client = await boot(new FakeProvider().set(RELEASE, { kind: 'raw', resolution }));
    expect(await settle(client.evaluate(RELEASE, ctx))).toEqual({
      value: false,
      source: 'safe_value',
      errorCode: code,
    });
  });

  it('a plain result, not a promise, is used like a resolved one', async () => {
    const fake = new FakeProvider().set(RELEASE, { kind: 'plain', value: true });
    const client = await boot(fake);
    expect(await settle(client.evaluate(RELEASE, ctx))).toEqual({
      value: true,
      source: 'provider',
    });
  });

  it('a synchronous FlagNotFoundError keeps its code', async () => {
    const fake = new FakeProvider().set(KILL_SAFE_ON, {
      kind: 'throw_sync',
      error: new FlagNotFoundError('x'),
    });
    const client = await boot(fake);
    expect(await settle(client.evaluate(KILL_SAFE_ON, ctx))).toEqual({
      value: true,
      source: 'safe_value',
      errorCode: 'FLAG_NOT_FOUND',
    });
  });

  it('a thrown object that is not an OpenFeature error counts as general', async () => {
    const fake = new FakeProvider().set(KILL_SAFE_ON, {
      kind: 'throw',
      error: { code: 'NOT_A_CODE' },
    });
    const client = await boot(fake);
    expect(await settle(client.evaluate(KILL_SAFE_ON, ctx))).toEqual({
      value: true,
      source: 'safe_value',
      errorCode: 'FLAG_GENERAL',
    });
  });
});

describe('what the provider is handed', () => {
  it('a frozen context, so a provider cannot change it for later calls', async () => {
    const fake = new FakeProvider().set(RELEASE, { kind: 'value', value: false });
    const client = await boot(fake);
    await client.evaluate(RELEASE, fullCtx);
    expect(Object.isFrozen(fake.callsFor(RELEASE)[0]?.context)).toBe(true);
  });

  it('a logger that keeps nothing, since provider lines can carry context values', async () => {
    const fake = new FakeProvider().set(RELEASE, { kind: 'value', value: false });
    const client = await boot(fake);
    await client.evaluate(RELEASE, fullCtx);
    const logger = fake.callsFor(RELEASE)[0]?.logger;
    expect(logger).toBeDefined();
    const consoleSpies = (['error', 'warn', 'info', 'debug', 'log'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    try {
      for (const method of ['error', 'warn', 'info', 'debug'] as const) {
        expect(logger?.[method](USER, ORG)).toBeUndefined();
      }
      for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
    }
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

// A hook anywhere in the process can rewrite the context before the provider sees it, or
// the result after. Neither may change what a flag answers for an organization.
describe('hostile OpenFeature hooks', () => {
  const REWRITE = { internal: true, targetingKey: OTHER_ORG, organizationId: OTHER_ORG };
  const PINNED = { targetingKey: ORG, organizationId: ORG, internal: false };
  // On only for an internal organization or for OTHER_ORG, so any rewrite that got through
  // would turn the flag on for ORG.
  const rule = (context: EvaluationContext) =>
    context['internal'] === true ||
    context.targetingKey === OTHER_ORG ||
    context['organizationId'] === OTHER_ORG;

  function rewriting(): Hook {
    return {
      before: (hookContext) => {
        // Writes through the shared context as well as returning a new one.
        Object.assign(hookContext.context, REWRITE);
        return { ...REWRITE };
      },
      after: (_hookContext, details) => {
        Object.assign(details, { value: true, errorCode: undefined });
      },
      error: () => undefined,
      finally: (_hookContext, details) => {
        Object.assign(details, { value: true, errorCode: undefined, reason: 'STATIC' });
      },
    };
  }

  function throwing(): Hook {
    const fail = () => {
      throw new Error('hook failed');
    };
    return { before: fail, after: fail, error: fail, finally: fail };
  }

  // Hands back the OpenFeature client the flag client builds, as a caller holding it would.
  function captureClient(): () => OpenFeatureClient {
    const spy = vi.spyOn(OpenFeature, 'getClient');
    return () => {
      const result = spy.mock.results.at(-1);
      if (result?.type !== 'return') throw new Error('no OpenFeature client was created');
      return result.value;
    };
  }

  type Install = (fake: FakeProvider, hook: Hook, client: () => OpenFeatureClient) => void;
  const PLACES: [string, Install][] = [
    [
      'global, by OpenFeature.addHooks',
      (_fake, hook) => {
        OpenFeature.addHooks(hook);
      },
    ],
    [
      'on the client',
      (_fake, hook, client) => {
        client().addHooks(hook);
      },
    ],
    // The SDK runs provider hooks after call level ones, and flagd adds one in sync mode.
    [
      'on the provider',
      (fake, hook) => {
        fake.hooks.push(hook);
      },
    ],
  ];

  afterEach(() => {
    OpenFeature.clearHooks();
    vi.restoreAllMocks();
  });

  describe.each(PLACES)('a hook %s', (_place, place) => {
    it('cannot rewrite the context the provider sees', async () => {
      const client = captureClient();
      const fake = new FakeProvider().set(RELEASE, { kind: 'rule', rule });
      const flagClient = await boot(fake);
      place(fake, rewriting(), client);
      expect(await settle(flagClient.evaluate(RELEASE, ctx))).toEqual({
        value: false,
        source: 'provider',
      });
      expect(fake.callsFor(RELEASE).map((call) => call.context)).toEqual([PINNED]);
    });

    it('keeps the projectId and userId of the caller', async () => {
      const client = captureClient();
      const fake = new FakeProvider().set(RELEASE, { kind: 'value', value: false });
      const flagClient = await boot(fake);
      place(
        fake,
        { before: () => ({ projectId: 'someone-else', userId: 'someone-else' }) },
        client,
      );
      await settle(flagClient.evaluate(RELEASE, fullCtx));
      expect(fake.callsFor(RELEASE)[0]?.context).toEqual({
        targetingKey: ORG,
        organizationId: ORG,
        projectId: PROJECT,
        userId: USER,
        internal: true,
      });
    });

    it.each(PROVIDER_FLAGS)(
      'cannot rewrite the answer for %s after the provider gave it',
      async (name, safe) => {
        const client = captureClient();
        const fake = new FakeProvider().set(name, { kind: 'value', value: false });
        const flagClient = await boot(fake);
        place(fake, rewriting(), client);
        expect(await settle(flagClient.evaluate(name, ctx))).toEqual({
          value: false,
          source: 'provider',
        });
        // A failed evaluation stays failed, whatever the hook writes over it.
        fake.set(name, { kind: 'throw', error: new Error('boom') });
        expect(await settle(flagClient.evaluate(name, ctx))).toEqual({
          value: safe,
          source: 'safe_value',
          errorCode: 'FLAG_GENERAL',
        });
      },
    );

    describe.each(PROVIDER_FLAGS)('a hook that throws, %s', (name, safe) => {
      it.each([true, false])('leaves the provider answer %s as it is', async (value) => {
        const client = captureClient();
        const fake = new FakeProvider().set(name, { kind: 'value', value });
        const flagClient = await boot(fake);
        place(fake, throwing(), client);
        expect(await settle(flagClient.evaluate(name, ctx))).toEqual({
          value,
          source: 'provider',
        });
      });

      it('still gives the safe value when the provider fails', async () => {
        const client = captureClient();
        const fake = new FakeProvider().set(name, {
          kind: 'error_result',
          errorCode: ErrorCode.GENERAL,
          value: !safe,
        });
        const flagClient = await boot(fake);
        place(fake, throwing(), client);
        expect(await settle(flagClient.evaluate(name, ctx))).toEqual({
          value: safe,
          source: 'safe_value',
          errorCode: 'FLAG_GENERAL',
        });
      });
    });
  });

  // Both states of every release flag, in the fixture registry and the package one, with a
  // hostile hook in each place at once.
  const RELEASE_NAMES = [...fixtureFlags, ...flags]
    .filter((flag) => flag.kind === 'release')
    .map((flag) => flag.name);

  describe.each(RELEASE_NAMES)('release flag %s with hostile hooks everywhere', (name) => {
    it.each([true, false])('serves %s as the provider decides', async (value) => {
      const client = captureClient();
      const fake = new FakeProvider().set(name, {
        kind: 'rule',
        rule: (context) => (rule(context) ? !value : value),
      });
      install(fake);
      const flagClient = await createFlagClient(fileConfig, {
        entitlements: entitlements().reader,
        registry: defineRegistryOf(name),
      });
      open.push(flagClient);
      for (const [, place] of PLACES) place(fake, rewriting(), client);
      expect(await settle(flagClient.evaluate(name, ctx))).toEqual({
        value,
        source: 'provider',
      });
      expect(await settle(flagClient.evaluate(name, { ...ctx, internal: true }))).toEqual({
        value: !value,
        source: 'provider',
      });
    });
  });

  function defineRegistryOf(name: string) {
    const definition = [...fixtureFlags, ...flags].find((flag) => flag.name === name);
    if (definition === undefined) throw new Error(`no flag ${name}`);
    return [definition] as const;
  }

  const rewriteKey = fc.oneof(
    fc.constantFrom('targetingKey', 'organizationId', 'internal', 'projectId', 'userId'),
    fc.string({ maxLength: 12 }),
  );
  const rewriteValue = fc.oneof(
    fc.constantFrom<unknown>(ORG, OTHER_ORG, true, false, 'true', 1, null),
    fc.string({ maxLength: 12 }),
    fc.boolean(),
    fc.integer(),
  );
  const rewrites = fc.dictionary(rewriteKey, rewriteValue, { maxKeys: 6 });
  const callerCtx = fc.record({
    organizationId: fc.constantFrom(ORG, OTHER_ORG),
    internal: fc.boolean(),
  });

  describe.each(SEEDS)('under any rewrite from a global hook, seed %i', (seed) => {
    it('evaluates exactly as with no hook', { timeout: PROVIDER_PROPERTY_TIMEOUT_MS }, async () => {
      const fake = new FakeProvider().set(RELEASE, { kind: 'rule', rule });
      const flagClient = await boot(fake);
      await fc.assert(
        fc.asyncProperty(rewrites, callerCtx, async (rewrite, caller) => {
          OpenFeature.clearHooks();
          fake.calls.length = 0;
          const clean = await settle(flagClient.evaluate(RELEASE, caller));
          OpenFeature.addHooks({
            before: (hookContext) => {
              Object.assign(hookContext.context, rewrite);
              return rewrite as EvaluationContext;
            },
          });
          const hooked = await settle(flagClient.evaluate(RELEASE, caller));
          const [first, second] = fake.calls;
          expect(hooked).toEqual(clean);
          expect(second?.context).toEqual(first?.context);
        }),
        { seed, numRuns: 60 },
      );
    });
  });
});
