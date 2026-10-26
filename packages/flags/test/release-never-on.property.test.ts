import {
  ErrorCode,
  FlagNotFoundError,
  GeneralError,
  ParseError,
  ProviderEvents,
  TypeMismatchError,
} from '@openfeature/server-sdk';
import fc from 'fast-check';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlagClient, type FlagEvaluation } from '../src/index.ts';
import { FakeProvider, type Behaviour, type InitMode } from './support/fake-provider.ts';
import { install, reset } from './support/flagd.ts';
import {
  EXPERIMENT,
  KILL_SAFE_OFF,
  KILL_SAFE_ON,
  RELEASE,
  ctx,
  entitlements,
  fileConfig,
  fixtureFlags,
} from './support/fixtures.ts';
import { SEEDS } from './support/seeds.ts';

vi.mock('@openfeature/flagd-provider', () => import('./support/flagd.ts'));

// Every way a provider call can fail, tagged so the run can prove each one was generated.
interface Failure {
  readonly tag: string;
  readonly behaviour: Behaviour;
}
const tagged = (tag: string, behaviour: Behaviour): Failure => ({ tag, behaviour });

const failure: fc.Arbitrary<Failure> = fc.oneof(
  fc.constant(tagged('throw_error', { kind: 'throw', error: new Error('x') })),
  fc.constant(tagged('throw_string', { kind: 'throw', error: 'x' })),
  fc.constant(tagged('throw_undefined', { kind: 'throw', error: undefined })),
  fc.constant(tagged('throw_sync', { kind: 'throw_sync', error: new Error('x') })),
  fc
    .constantFrom(
      new FlagNotFoundError('x'),
      new ParseError('x'),
      new TypeMismatchError('x'),
      new GeneralError('x'),
    )
    .map((error) => tagged(`throw_${error.code}`, { kind: 'throw', error })),
  fc.constant(tagged('hang', { kind: 'hang' })),
  fc
    .integer({ min: 51, max: 5000 })
    .map((afterMs) => tagged('late_true', { kind: 'late_value', afterMs, value: true })),
  fc
    .integer({ min: 51, max: 5000 })
    .map((afterMs) =>
      tagged('late_throw', { kind: 'late_throw', afterMs, error: new Error('late') }),
    ),
  fc
    .tuple(fc.constantFrom(...Object.values(ErrorCode)), fc.oneof(fc.constant(true), fc.anything()))
    .map(([errorCode, value]) =>
      tagged(`error_result_${errorCode}`, { kind: 'error_result', errorCode, value }),
    ),
  fc
    .anything()
    .filter((value) => typeof value !== 'boolean')
    .map((value) => tagged('wrong_type', { kind: 'value', value })),
  fc
    .constantFrom<unknown>('true', 'on', '1', 1, -1, Number.NaN, {}, [true], null, undefined)
    .map((value) => tagged('truthy_wrong_type', { kind: 'value', value })),
);

const flagUnderTest = fc.constantFrom(
  [RELEASE, false] as const,
  [EXPERIMENT, false] as const,
  [KILL_SAFE_ON, true] as const,
  [KILL_SAFE_OFF, false] as const,
);

type Step =
  | {
      readonly kind: 'eval';
      readonly flag: readonly [
        typeof RELEASE | typeof EXPERIMENT | typeof KILL_SAFE_ON | typeof KILL_SAFE_OFF,
        boolean,
      ];
      readonly failure: Failure;
      readonly via: 'evaluate' | 'isOn';
    }
  | { readonly kind: 'event'; readonly event: 'stale' | 'error' | 'fatal' | 'ready' | 'changed' }
  | { readonly kind: 'advance'; readonly ms: number };

const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant('eval' as const),
      flag: flagUnderTest,
      failure,
      via: fc.constantFrom('evaluate' as const, 'isOn' as const),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('event' as const),
      event: fc.constantFrom(
        'stale' as const,
        'error' as const,
        'fatal' as const,
        'ready' as const,
        'changed' as const,
      ),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('advance' as const),
      ms: fc.integer({ min: 0, max: 10 * 60 * 1000 }),
    }),
  },
);

const scenario = fc.record({
  init: fc.constantFrom<InitMode>('ready', 'hang', 'reject', 'none'),
  steps: fc.array(step, { minLength: 1, maxLength: 12 }),
});

const seenTags = new Set<string>();
const seenInit = new Set<string>();
let releaseChecks = 0;

beforeEach(() => {
  vi.useFakeTimers();
  reset();
});

afterEach(() => {
  vi.useRealTimers();
});

async function run({ init, steps }: { init: InitMode; steps: readonly Step[] }) {
  seenInit.add(init);
  const fake = new FakeProvider(init);
  install(fake);
  const pending = createFlagClient(fileConfig, {
    entitlements: entitlements().reader,
    registry: fixtureFlags,
  });
  await vi.advanceTimersByTimeAsync(fileConfig.initTimeoutMs);
  const client = await pending;
  try {
    for (const s of steps) {
      if (s.kind === 'advance') {
        await vi.advanceTimersByTimeAsync(s.ms);
        continue;
      }
      if (s.kind === 'event') {
        if (s.event === 'stale') fake.emit(ProviderEvents.Stale);
        if (s.event === 'error') fake.emit(ProviderEvents.Error);
        if (s.event === 'fatal') fake.emit(ProviderEvents.Error, ErrorCode.PROVIDER_FATAL);
        if (s.event === 'ready') fake.emit(ProviderEvents.Ready);
        if (s.event === 'changed') fake.emit(ProviderEvents.ConfigurationChanged);
        continue;
      }
      const [name, safe] = s.flag;
      seenTags.add(s.failure.tag);
      fake.set(name, s.failure.behaviour);
      if (s.via === 'isOn') {
        const pendingValue = client.isOn(name, ctx);
        await vi.advanceTimersByTimeAsync(fileConfig.evalTimeoutMs);
        const value = await pendingValue;
        expect(value, `${name} after ${s.failure.tag}`).toBe(safe);
      } else {
        const pendingResult = client.evaluate(name, ctx);
        await vi.advanceTimersByTimeAsync(fileConfig.evalTimeoutMs);
        const result: FlagEvaluation = await pendingResult;
        expect(result.value, `${name} after ${s.failure.tag}`).toBe(safe);
        expect(result.source, `${name} after ${s.failure.tag}`).toBe('safe_value');
        expect(result.errorCode, `${name} after ${s.failure.tag}`).toBeDefined();
      }
      if (name === RELEASE) releaseChecks += 1;
    }
  } finally {
    // Late answers still queued must not reach a later run.
    await vi.advanceTimersByTimeAsync(10_000);
    await client.close();
  }
}

describe.each(SEEDS)('under any sequence of provider failures, seed %i', (seed) => {
  it('a release or experiment flag never evaluates on and a kill switch holds its safe value', async () => {
    await fc.assert(fc.asyncProperty(scenario, run), { seed, numRuns: 60 });
  });
});

describe('the generated failures', () => {
  afterAll(() => {
    seenTags.clear();
  });

  it('covered every failure kind, every start mode and many release checks', () => {
    // Runs after the seeded properties in this file; vitest keeps file order.
    for (const tag of [
      'throw_error',
      'throw_string',
      'throw_undefined',
      'throw_sync',
      'throw_FLAG_NOT_FOUND',
      'throw_PARSE_ERROR',
      'throw_TYPE_MISMATCH',
      'throw_GENERAL',
      'hang',
      'late_true',
      'late_throw',
      'wrong_type',
      'truthy_wrong_type',
      `error_result_${ErrorCode.FLAG_NOT_FOUND}`,
      `error_result_${ErrorCode.GENERAL}`,
      `error_result_${ErrorCode.PROVIDER_NOT_READY}`,
    ]) {
      expect(seenTags, tag).toContain(tag);
    }
    expect([...seenInit].sort()).toEqual(['hang', 'none', 'ready', 'reject']);
    expect(releaseChecks).toBeGreaterThan(100);
  });
});
