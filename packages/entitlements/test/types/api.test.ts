// Checked by tsc through pnpm typecheck. The runtime part only proves the file loads.
import { describe, expectTypeOf, it } from 'vitest';
import { UNLIMITED, checkLimit, entitlementsFor, hasFeature, limitFor } from '../../src/index.ts';
import type {
  CheckResult,
  FeatureKey,
  LimitKey,
  LimitValue,
  Product,
  Tier,
} from '../../src/index.ts';

describe('public types', () => {
  it('names the six tiers and three products and nothing else', () => {
    expectTypeOf<Tier>().toEqualTypeOf<
      'free' | 'starter' | 'growth' | 'scale' | 'enterprise' | 'self_hosted'
    >();
    expectTypeOf<Product>().toEqualTypeOf<'docs' | 'studio' | 'status'>();
  });

  it('keeps the unlimited value out of the number type', () => {
    expectTypeOf(UNLIMITED).not.toEqualTypeOf<number>();
    expectTypeOf<LimitValue>().toEqualTypeOf<number | typeof UNLIMITED>();
  });

  it('types keys, so a typo is a compile error before it is a runtime error', () => {
    expectTypeOf<'org.seats'>().toExtend<LimitKey>();
    expectTypeOf<'docs.seats'>().not.toExtend<LimitKey>();
    expectTypeOf<'docs.versioning'>().toExtend<FeatureKey>();
    expectTypeOf<'org.seats'>().not.toExtend<FeatureKey>();

    // @ts-expect-error an unknown tier
    expectTypeOf(checkLimit).toBeCallableWith('pro', 'org.seats', 1);
    // @ts-expect-error an unknown limit key
    expectTypeOf(limitFor).toBeCallableWith('free', 'docs.seats');
    // @ts-expect-error a limit key is not a feature
    expectTypeOf(hasFeature).toBeCallableWith('free', 'org.seats');
    // @ts-expect-error usage is a number, not a string
    expectTypeOf(checkLimit).toBeCallableWith('free', 'org.seats', '1');
    // @ts-expect-error an unknown product
    expectTypeOf(entitlementsFor).toBeCallableWith('website');
  });

  it('returns a result whose refusals say read only', () => {
    expectTypeOf(checkLimit('free', 'org.seats', 1)).toEqualTypeOf<CheckResult>();
    expectTypeOf<CheckResult['status']>().toEqualTypeOf<
      'allowed' | 'over_limit' | 'not_entitled'
    >();
    expectTypeOf<
      Extract<CheckResult, { status: 'over_limit' }>['access']
    >().toEqualTypeOf<'read_only'>();
    expectTypeOf<
      Extract<CheckResult, { status: 'not_entitled' }>['access']
    >().toEqualTypeOf<'read_only'>();
  });
});
