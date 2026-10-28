// Checked by tsc through pnpm typecheck. The runtime part only proves the file loads.
import { describe, expectTypeOf, it } from 'vitest';
import {
  defineFlags,
  type FlagClient,
  type FileFlagConfig,
  type FlagConfig,
  type FlagContext,
  type FlagdFlagConfig,
  type FlagEvaluation,
  type FlagName,
  type KillSwitch,
  type ReleaseFlag,
} from '../../src/index.ts';
import { createTestFlagClient } from '../../src/testing.ts';
import type { fixtureFlags } from '../support/fixtures.ts';
import { ORG } from '../support/fixtures.ts';

// A value typed as plain string, built at run time so nothing narrows it.
const someString = ['product', 'docs'].join('.');
type IsOn = FlagClient['isOn'];
type Evaluate = FlagClient['evaluate'];
type FixtureIsOn = FlagClient<typeof fixtureFlags>['isOn'];
type FixtureEvaluate = FlagClient<typeof fixtureFlags>['evaluate'];
const ctx: FlagContext = { organizationId: ORG };

const base = {
  owner: 'Divine572',
  description: 'Type test.',
  created: '2026-10-01',
  removeBy: '2027-01-01',
} as const;

describe('flag names', () => {
  it('are the registry union and nothing else', () => {
    expectTypeOf<FlagName>().toEqualTypeOf<
      'product.docs' | 'product.studio' | 'product.status' | 'dashboard.shell'
    >();
  });

  it('an unregistered name fails typecheck on every method', () => {
    expectTypeOf<IsOn>().toBeCallableWith('product.docs', ctx);
    expectTypeOf<Evaluate>().toBeCallableWith('product.studio', ctx);
    // @ts-expect-error not in the registry
    expectTypeOf<IsOn>().toBeCallableWith('product.website', ctx);
    // @ts-expect-error not in the registry
    expectTypeOf<Evaluate>().toBeCallableWith('product.website', ctx);
    // @ts-expect-error case matters
    expectTypeOf<IsOn>().toBeCallableWith('Product.docs', ctx);
    // @ts-expect-error a plain string is not a flag name
    expectTypeOf<IsOn>().toBeCallableWith(someString, ctx);
  });

  it('a name from another registry fails typecheck', () => {
    // @ts-expect-error the package client does not know the fixture flags
    expectTypeOf<IsOn>().toBeCallableWith('content.standard_render', ctx);
    expectTypeOf<FixtureIsOn>().toBeCallableWith('content.standard_render', ctx);
  });

  it('plan flags go through evaluate, not isOn', () => {
    expectTypeOf<FixtureEvaluate>().toBeCallableWith('docs.versioning', ctx);
    // @ts-expect-error isOn excludes plan flags
    expectTypeOf<FixtureIsOn>().toBeCallableWith('docs.versioning', ctx);
  });

  it('test overrides are keyed by flag name', () => {
    // Never called; tsc checks the calls.
    const typeOnly = () => {
      createTestFlagClient({ 'product.docs': true });
      // @ts-expect-error not in the registry
      createTestFlagClient({ 'product.website': true });
    };
    expectTypeOf(typeOnly).toBeFunction();
  });
});

// The calls below hold invalid definitions that defineFlags rejects at run time, so they sit
// in functions that are never called; tsc still checks every one.
describe('definitions', () => {
  it('a kill switch without safeValue fails typecheck', () => {
    const typeOnly = () => {
      defineFlags([
        // @ts-expect-error safeValue is required on a kill switch
        { ...base, name: 'ai.generation', kind: 'kill_switch' },
      ]);
      defineFlags([{ ...base, name: 'ai.generation', kind: 'kill_switch', safeValue: true }]);
    };
    expectTypeOf(typeOnly).toBeFunction();
    expectTypeOf<KillSwitch['safeValue']>().toEqualTypeOf<boolean>();
  });

  it('a release flag cannot fail open', () => {
    expectTypeOf<ReleaseFlag['safeValue']>().toEqualTypeOf<false>();
    const typeOnly = () => {
      defineFlags([
        // @ts-expect-error a release flag is false when unsure, by type
        { ...base, name: 'status.sms', kind: 'release', safeValue: true },
      ]);
      defineFlags([
        // @ts-expect-error safeValue is required on a release flag too
        { ...base, name: 'status.sms', kind: 'release' },
      ]);
    };
    expectTypeOf(typeOnly).toBeFunction();
  });

  it('an experiment needs a metric and cannot fail open', () => {
    const typeOnly = () => {
      defineFlags([
        // @ts-expect-error metric is required
        { ...base, name: 'site.hero_copy', kind: 'experiment', safeValue: false },
      ]);
      defineFlags([
        // @ts-expect-error an experiment is false when unsure
        { ...base, name: 'site.hero_copy', kind: 'experiment', safeValue: true, metric: 'Signups' },
      ]);
    };
    expectTypeOf(typeOnly).toBeFunction();
  });

  it('a plan flag names an entitlements feature', () => {
    const typeOnly = () => {
      defineFlags([{ ...base, name: 'docs.versioning', kind: 'plan', feature: 'docs.versioning' }]);
      defineFlags([
        // @ts-expect-error not an entitlements feature
        { ...base, name: 'docs.versioning', kind: 'plan', feature: 'docs.teleport' },
      ]);
    };
    expectTypeOf(typeOnly).toBeFunction();
  });

  it('a name needs a known area', () => {
    const typeOnly = () => {
      defineFlags([
        // @ts-expect-error website is not an area
        { ...base, name: 'website.hero', kind: 'release', safeValue: false },
      ]);
    };
    expectTypeOf(typeOnly).toBeFunction();
  });

  it('an unknown kind fails typecheck', () => {
    const typeOnly = () => {
      defineFlags([
        // @ts-expect-error permanent is not a kind
        { ...base, name: 'status.sms', kind: 'permanent', safeValue: false },
      ]);
    };
    expectTypeOf(typeOnly).toBeFunction();
  });
});

describe('client and config', () => {
  it('returns booleans and evaluations', () => {
    expectTypeOf<ReturnType<IsOn>>().toEqualTypeOf<Promise<boolean>>();
    expectTypeOf<ReturnType<Evaluate>>().toEqualTypeOf<Promise<FlagEvaluation>>();
    expectTypeOf<FlagEvaluation['source']>().toEqualTypeOf<
      'provider' | 'safe_value' | 'test_override' | 'entitlements'
    >();
  });

  it('needs a branded organization ID in the context', () => {
    // @ts-expect-error a plain string is not an OrganizationId
    const bad: FlagContext = { organizationId: '0192b7a4-5c1e-7d2a-9f3b-1a2b3c4d5e6f' };
    expectTypeOf(bad).toEqualTypeOf<FlagContext>();
  });

  it('has no way to choose the RPC resolver', () => {
    expectTypeOf<FlagConfig['source']>().toEqualTypeOf<'file' | 'flagd'>();
    type Keys = keyof FileFlagConfig | keyof FlagdFlagConfig;
    expectTypeOf<'resolverType' extends Keys ? true : false>().toEqualTypeOf<false>();
    // @ts-expect-error rpc is not a source
    const source: FlagConfig = { source: 'rpc', file: '/x', evalTimeoutMs: 50, initTimeoutMs: 1 };
    expectTypeOf(source).toEqualTypeOf<FlagConfig>();
  });
});
