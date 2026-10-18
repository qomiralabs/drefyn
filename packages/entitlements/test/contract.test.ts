// Edges of the check API that the table and property suites do not pin on their own:
// which error wins when several inputs are bad, floors, the product views of grace and
// metadata, and arithmetic at the top of the safe integer range.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  PRODUCTS,
  UNLIMITED,
  checkLimit,
  entitlementsFor,
  featureInfo,
  graceAllowance,
  limitFor,
  limitInfo,
} from '../src/index.ts';
import type { FeatureKey, LimitKey, LimitOverrides, Tier } from '../src/index.ts';
import * as pricing from './fixtures/pricing.ts';
import { RUNS, caughtCode, expectEntitlementError } from './support/assert.ts';

const tier = (value: unknown) => value as Tier;
const key = (value: unknown) => value as LimitKey;
const overrides = (value: unknown) => value as LimitOverrides;

describe('validation order: tier, then key, then overrides, then usage', () => {
  const lowering = overrides({ 'status.monitors': 1 });

  it('reports the tier first when everything is wrong', () => {
    expectEntitlementError(
      () => checkLimit(tier('pro'), key('nope'), 1.5, { overrides: lowering }),
      'ENTITLEMENT_UNKNOWN_TIER',
    );
  });

  it('reports the key before the overrides and the usage', () => {
    expectEntitlementError(
      () => checkLimit('growth', key('nope'), 1.5, { overrides: lowering }),
      'ENTITLEMENT_UNKNOWN_LIMIT',
    );
  });

  it('reports the overrides before the usage', () => {
    expectEntitlementError(
      () => checkLimit('growth', 'org.seats', 1.5, { overrides: lowering }),
      'ENTITLEMENT_OVERRIDE_LOWERS_LIMIT',
    );
    expectEntitlementError(
      () =>
        checkLimit('growth', 'org.seats', -1, { overrides: overrides({ 'status.monitors': -1 }) }),
      'ENTITLEMENT_INVALID_OVERRIDE',
    );
  });

  it('reports the usage last', () => {
    expectEntitlementError(
      () => checkLimit('growth', 'org.seats', -1),
      'ENTITLEMENT_INVALID_USAGE',
    );
  });

  it('checks entries in order and stops at the first bad one', () => {
    const error = expectEntitlementError(
      () =>
        limitFor('growth', 'org.seats', {
          overrides: overrides({ 'status.monitors': 1, 'org.seat': 5 }),
        }),
      'ENTITLEMENT_OVERRIDE_LOWERS_LIMIT',
    );
    expect(error.limitKey).toBe('status.monitors');
    expectEntitlementError(
      () =>
        limitFor('growth', 'org.seats', {
          overrides: overrides({ 'org.seat': 5, 'status.monitors': 1 }),
        }),
      'ENTITLEMENT_UNKNOWN_LIMIT',
    );
  });
});

describe('the overrides argument itself', () => {
  for (const [label, value] of [
    ['null', null],
    ['a number', 5],
    ['a string', 'unlimited'],
    ['a function', () => 5],
  ] as const) {
    it(`refuses ${label} in place of a map, naming no key`, () => {
      const error = expectEntitlementError(
        () => limitFor('enterprise', 'org.seats', { overrides: overrides(value) }),
        'ENTITLEMENT_INVALID_OVERRIDE',
      );
      expect(error.limitKey).toBeUndefined();
      expect(Object.hasOwn(error, 'limitKey')).toBe(false);
    });
  }

  it('treats an explicit undefined map as no overrides', () => {
    expect(limitFor('growth', 'status.monitors', { overrides: overrides(undefined) })).toBe(200);
  });

  it('accepts negative zero as an override of zero', () => {
    expect(
      Object.is(
        limitFor('free', 'status.private_probes', {
          overrides: overrides({ 'status.private_probes': -0 }),
        }),
        0,
      ),
    ).toBe(true);
  });

  it('only gives grace for graceEligible exactly true', () => {
    const loose = { graceEligible: 'yes' as unknown as boolean };
    expect(checkLimit('free', 'status.email_sends_per_month', 2001, loose)).toMatchObject({
      status: 'over_limit',
      grace: 0,
    });
  });
});

describe('floors', () => {
  it('measures excess on a min key as how far below the floor the usage is', () => {
    expect(checkLimit('free', 'status.check_interval_seconds', 30)).toMatchObject({
      status: 'over_limit',
      limit: 180,
      grace: 0,
      excess: 150,
      access: 'read_only',
    });
    expect(checkLimit('starter', 'status.check_interval_seconds', 0)).toMatchObject({
      status: 'over_limit',
      excess: 60,
    });
  });

  it('never applies grace to a floor', () => {
    expect(
      checkLimit('free', 'status.check_interval_seconds', 179, { graceEligible: true }),
    ).toMatchObject({ status: 'over_limit', grace: 0, excess: 1 });
  });

  it('lifts the floor entirely with an unlimited override', () => {
    const open = overrides({ 'status.check_interval_seconds': UNLIMITED });
    expect(
      checkLimit('free', 'status.check_interval_seconds', 1, { overrides: open }),
    ).toMatchObject({ status: 'allowed', limit: UNLIMITED, grace: 0 });
  });
});

describe('the top of the safe integer range', () => {
  const huge = overrides({ 'status.email_sends_per_month': Number.MAX_SAFE_INTEGER });

  it('sizes grace on the largest cap without leaving the safe range', () => {
    const grace = graceAllowance('enterprise', 'status.email_sends_per_month', { overrides: huge });
    // floor((2^53 - 1) / 4), computed exactly with bigint as the reference.
    expect(grace).toBe(Number((2n ** 53n - 1n) / 4n));
    expect(Number.isSafeInteger(grace)).toBe(true);
  });

  it('allows any usage when cap plus grace is past the largest safe integer', () => {
    expect(
      checkLimit('enterprise', 'status.email_sends_per_month', Number.MAX_SAFE_INTEGER, {
        overrides: huge,
        graceEligible: true,
      }).status,
    ).toBe('allowed');
  });

  it('matches floor(cap * 25 / 100) computed in bigint for any cap', () => {
    fc.assert(
      fc.property(fc.integer({ min: 250_000, max: Number.MAX_SAFE_INTEGER }), (cap) => {
        const grace = graceAllowance('enterprise', 'status.email_sends_per_month', {
          overrides: overrides({ 'status.email_sends_per_month': cap }),
        });
        return grace === Number((BigInt(cap) * 25n) / 100n);
      }),
      RUNS,
    );
  });
});

describe('every product view agrees beyond checkLimit', () => {
  const tierArb = fc.constantFrom(...(pricing.TIERS as readonly Tier[]));
  const keyArb = fc.constantFrom(...(pricing.LIMIT_KEYS as readonly LimitKey[]));
  const featureArb = fc.constantFrom(...(pricing.FEATURE_KEYS as readonly FeatureKey[]));

  it('gives the same grace allowance through Docs, Studio and Status', () => {
    fc.assert(
      fc.property(tierArb, keyArb, (t, k) => {
        for (const product of PRODUCTS) {
          expect(entitlementsFor(product).graceAllowance(t, k)).toBe(graceAllowance(t, k));
        }
      }),
      RUNS,
    );
  });

  it('gives the same limit and feature metadata through every product', () => {
    fc.assert(
      fc.property(keyArb, featureArb, (k, feat) => {
        for (const product of PRODUCTS) {
          const api = entitlementsFor(product);
          expect(api.limitInfo(k)).toEqual(limitInfo(k));
          expect(api.featureInfo(feat)).toEqual(featureInfo(feat));
        }
      }),
      RUNS,
    );
  });

  it('fails grace and metadata the same way through every product for bad input', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (t, k) => {
        const grace = caughtCode(() => graceAllowance(tier(t), key(k)));
        const info = caughtCode(() => limitInfo(key(k)));
        const feat = caughtCode(() => featureInfo(k as FeatureKey));
        for (const product of PRODUCTS) {
          const api = entitlementsFor(product);
          expect(caughtCode(() => api.graceAllowance(tier(t), key(k)))).toBe(grace);
          expect(caughtCode(() => api.limitInfo(key(k)))).toBe(info);
          expect(caughtCode(() => api.featureInfo(k as FeatureKey))).toBe(feat);
        }
      }),
      RUNS,
    );
  });

  it('names its product and is frozen', () => {
    for (const product of PRODUCTS) {
      const api = entitlementsFor(product);
      expect(api.product).toBe(product);
      expect(Object.isFrozen(api)).toBe(true);
      expect(entitlementsFor(product)).toBe(api);
    }
  });
});

describe('results and metadata are frozen', () => {
  it('freezes every result shape', () => {
    const results = [
      checkLimit('free', 'org.seats', 1),
      checkLimit('free', 'org.seats', 3),
      checkLimit('free', 'status.private_probes', 1),
      checkLimit('self_hosted', 'org.seats', 1),
      checkLimit('free', 'status.check_interval_seconds', 30),
    ];
    for (const result of results) expect(Object.isFrozen(result)).toBe(true);
  });

  it('freezes limit and feature metadata', () => {
    expect(Object.isFrozen(limitInfo('org.seats'))).toBe(true);
    expect(Object.isFrozen(featureInfo('docs.versioning'))).toBe(true);
  });
});
