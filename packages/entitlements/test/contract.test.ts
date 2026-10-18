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
import type { CheckOptions, FeatureKey, LimitKey, LimitOverrides, Tier } from '../src/index.ts';
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

  class Contract {
    readonly 'status.monitors' = 5000;
  }
  for (const [label, make] of [
    ['a Map', () => new Map([['status.email_sends_per_month', 1]])],
    ['an empty Map', () => new Map()],
    ['a Date', () => new Date(0)],
    ['an empty array', () => []],
    ['an array of entries', () => [['status.monitors', 5000]]],
    ['a class instance', () => new Contract()],
    ['a boxed number', (): unknown => Object(5)],
    ['a regular expression', () => /status/],
  ] as const) {
    it(`refuses ${label} in place of a map instead of treating it as none`, () => {
      const error = expectEntitlementError(
        () =>
          limitFor('enterprise', 'status.email_sends_per_month', { overrides: overrides(make()) }),
        'ENTITLEMENT_INVALID_OVERRIDE',
      );
      expect(error.limitKey).toBeUndefined();
    });
  }

  // A dictionary made with Object.create(null) has no prototype to inherit from, which is
  // exactly what an override map wants.
  it('accepts a null prototype map', () => {
    const map = Object.create(null) as Record<string, unknown>;
    map['status.monitors'] = 5000;
    expect(limitFor('enterprise', 'status.monitors', { overrides: overrides(map) })).toBe(5000);
  });

  it('refuses an own non enumerable entry, naming a known key', () => {
    const hidden = {};
    Object.defineProperty(hidden, 'org.seats', { value: 0, enumerable: false });
    const error = expectEntitlementError(
      () => limitFor('growth', 'org.seats', { overrides: overrides(hidden) }),
      'ENTITLEMENT_INVALID_OVERRIDE',
    );
    expect(error.limitKey).toBe('org.seats');
  });

  it('refuses an own non enumerable entry under an unknown name, naming nothing', () => {
    const hidden = {};
    Object.defineProperty(hidden, 'bogus', { value: 1, enumerable: false });
    const error = expectEntitlementError(
      () => limitFor('growth', 'org.seats', { overrides: overrides(hidden) }),
      'ENTITLEMENT_UNKNOWN_LIMIT',
    );
    expect(error.limitKey).toBeUndefined();
  });

  it('refuses a symbol keyed entry, naming nothing', () => {
    const error = expectEntitlementError(
      () =>
        limitFor('growth', 'org.seats', {
          overrides: overrides({ [Symbol('org.seats')]: UNLIMITED }),
        }),
      'ENTITLEMENT_UNKNOWN_LIMIT',
    );
    expect(error.limitKey).toBeUndefined();
  });

  // A getter could answer one value when checked and another when used; plain data only.
  it('refuses an accessor entry without calling it', () => {
    let calls = 0;
    const tricky = {};
    Object.defineProperty(tricky, 'status.monitors', {
      enumerable: true,
      get: () => {
        calls += 1;
        return 5000;
      },
    });
    const error = expectEntitlementError(
      () => limitFor('enterprise', 'status.monitors', { overrides: overrides(tricky) }),
      'ENTITLEMENT_INVALID_OVERRIDE',
    );
    expect(error.limitKey).toBe('status.monitors');
    expect(calls).toBe(0);
  });

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

describe('the options argument itself', () => {
  for (const [label, value] of [
    ['null', null],
    ['a string', 'graceEligible'],
    ['a number', 1],
    ['true', true],
    ['an array', []],
    ['a Map', new Map([['graceEligible', true]])],
  ] as const) {
    it(`refuses ${label} as options on every call that takes them`, () => {
      const options = value as unknown as CheckOptions;
      for (const run of [
        () => checkLimit('free', 'org.seats', 1, options),
        () => limitFor('free', 'org.seats', options),
        () => graceAllowance('free', 'status.email_sends_per_month', options),
      ]) {
        const error = expectEntitlementError(run, 'ENTITLEMENT_INVALID_OVERRIDE');
        expect(error.limitKey).toBeUndefined();
      }
    });
  }

  // A pollution bug elsewhere in the process must not become free grace or unlimited
  // sends for every tenant, so options are read as own data only.
  it('ignores a polluted Object.prototype, with no options and with empty options', () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto['overrides'] = { 'status.sms_sends_per_month': UNLIMITED };
    proto['graceEligible'] = true;
    try {
      for (const options of [undefined, {}]) {
        expect(checkLimit('free', 'status.sms_sends_per_month', 1000, options)).toMatchObject({
          status: 'not_entitled',
          limit: 0,
          grace: 0,
        });
        expect(checkLimit('starter', 'status.email_sends_per_month', 5001, options)).toMatchObject({
          status: 'over_limit',
          limit: 5000,
          grace: 0,
          excess: 1,
        });
        expect(limitFor('free', 'status.sms_sends_per_month', options)).toBe(0);
        expect(graceAllowance('starter', 'status.email_sends_per_month', options)).toBe(1250);
      }
    } finally {
      delete proto['overrides'];
      delete proto['graceEligible'];
    }
  });

  it('refuses an accessor graceEligible without calling it', () => {
    let calls = 0;
    const options = {};
    Object.defineProperty(options, 'graceEligible', {
      enumerable: true,
      get: () => {
        calls += 1;
        return true;
      },
    });
    const error = expectEntitlementError(
      () => checkLimit('free', 'status.email_sends_per_month', 2001, options),
      'ENTITLEMENT_INVALID_OVERRIDE',
    );
    expect(error.limitKey).toBeUndefined();
    expect(calls).toBe(0);
  });

  it('refuses an accessor or hidden overrides field without calling it', () => {
    let calls = 0;
    const accessor = {};
    Object.defineProperty(accessor, 'overrides', {
      enumerable: true,
      get: () => {
        calls += 1;
        return {};
      },
    });
    const hidden = {};
    Object.defineProperty(hidden, 'overrides', { value: {}, enumerable: false });
    for (const options of [accessor, hidden]) {
      expectEntitlementError(
        () => limitFor('free', 'org.seats', options),
        'ENTITLEMENT_INVALID_OVERRIDE',
      );
    }
    expect(calls).toBe(0);
  });

  it('accepts a null prototype options object', () => {
    const options = Object.create(null) as { graceEligible?: boolean };
    options.graceEligible = true;
    expect(checkLimit('free', 'status.email_sends_per_month', 2500, options).status).toBe(
      'allowed',
    );
  });

  it('checks options after the key and before the usage', () => {
    const bad = null as unknown as { readonly graceEligible?: boolean };
    expectEntitlementError(
      () => checkLimit('free', key('nope'), 1, bad),
      'ENTITLEMENT_UNKNOWN_LIMIT',
    );
    expectEntitlementError(
      () => checkLimit('free', 'org.seats', -1, bad),
      'ENTITLEMENT_INVALID_OVERRIDE',
    );
  });
});

describe('floors', () => {
  it('refuses a floor override of 0, since only UNLIMITED may remove the floor', () => {
    for (const t of pricing.TIERS) {
      if (t === 'self_hosted') continue;
      const error = expectEntitlementError(
        () =>
          limitFor(t, 'status.check_interval_seconds', {
            overrides: overrides({ 'status.check_interval_seconds': 0 }),
          }),
        'ENTITLEMENT_INVALID_OVERRIDE',
      );
      expect(error.limitKey).toBe('status.check_interval_seconds');
    }
    expectEntitlementError(
      () =>
        checkLimit('scale', 'status.check_interval_seconds', 1, {
          overrides: overrides({ 'status.check_interval_seconds': -0 }),
        }),
      'ENTITLEMENT_INVALID_OVERRIDE',
    );
  });

  it('accepts a floor override of 1 second, the shortest finite floor', () => {
    expect(
      limitFor('scale', 'status.check_interval_seconds', {
        overrides: overrides({ 'status.check_interval_seconds': 1 }),
      }),
    ).toBe(1);
  });

  it('has no floor of 0 anywhere in the table', () => {
    for (const t of pricing.TIERS) {
      for (const k of pricing.LIMIT_KEYS) {
        if (limitInfo(k).direction !== 'min') continue;
        expect(limitFor(t, k), `${t} ${k}`).not.toBe(0);
      }
    }
  });

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
