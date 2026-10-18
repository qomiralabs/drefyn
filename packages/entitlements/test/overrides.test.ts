// Contract overrides arrive from outside the open core (the hosted control plane) as a
// partial map of limit keys to values. They may only make a limit more generous: a
// higher max, a lower floor, or unlimited. A lower value is refused, so a bad contract
// record can never shrink what a paying customer already has.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { UNLIMITED, checkLimit, limitFor, limitInfo } from '../src/index.ts';
import type { LimitKey, LimitOverrides, Tier } from '../src/index.ts';
import * as pricing from './fixtures/pricing.ts';
import { RUNS, atLeastAsGenerous, caughtCode, expectEntitlementError } from './support/assert.ts';

const overrides = (value: Record<string, unknown>) => value as unknown as LimitOverrides;

describe('raise only overrides', () => {
  it('raises an enterprise email cap', () => {
    const raised = overrides({ 'status.email_sends_per_month': 1_000_000 });
    expect(limitFor('enterprise', 'status.email_sends_per_month', { overrides: raised })).toBe(
      1_000_000,
    );
    expect(
      checkLimit('enterprise', 'status.email_sends_per_month', 1_000_000, { overrides: raised })
        .status,
    ).toBe('allowed');
    expect(
      checkLimit('enterprise', 'status.email_sends_per_month', 1_000_001, { overrides: raised })
        .status,
    ).toBe('over_limit');
  });

  it('applies grace to the raised cap', () => {
    const options = {
      overrides: overrides({ 'status.email_sends_per_month': 1_000_000 }),
      openIncident: true,
    };
    expect(
      checkLimit('enterprise', 'status.email_sends_per_month', 1_250_000, options).status,
    ).toBe('allowed');
    expect(
      checkLimit('enterprise', 'status.email_sends_per_month', 1_250_001, options).status,
    ).toBe('over_limit');
  });

  it('accepts a value equal to the table, which changes nothing', () => {
    const same = overrides({ 'status.monitors': 200 });
    expect(limitFor('growth', 'status.monitors', { overrides: same })).toBe(200);
  });

  it('accepts unlimited', () => {
    const open = overrides({ 'org.docs_projects': UNLIMITED });
    expect(limitFor('scale', 'org.docs_projects', { overrides: open })).toBe(UNLIMITED);
  });

  it('refuses a lower cap with ENTITLEMENT_OVERRIDE_LOWERS_LIMIT', () => {
    const lowered = overrides({ 'status.email_sends_per_month': 249_999 });
    expectEntitlementError(
      () => limitFor('enterprise', 'status.email_sends_per_month', { overrides: lowered }),
      'ENTITLEMENT_OVERRIDE_LOWERS_LIMIT',
    );
    expectEntitlementError(
      () => checkLimit('enterprise', 'status.email_sends_per_month', 1, { overrides: lowered }),
      'ENTITLEMENT_OVERRIDE_LOWERS_LIMIT',
    );
  });

  it('refuses a finite value where the table is unlimited', () => {
    expectEntitlementError(
      () => limitFor('enterprise', 'org.seats', { overrides: overrides({ 'org.seats': 10_000 }) }),
      'ENTITLEMENT_OVERRIDE_LOWERS_LIMIT',
    );
    expectEntitlementError(
      () =>
        limitFor('self_hosted', 'status.monitors', {
          overrides: overrides({ 'status.monitors': Number.MAX_SAFE_INTEGER }),
        }),
      'ENTITLEMENT_OVERRIDE_LOWERS_LIMIT',
    );
  });

  it('treats a shorter check interval as a raise and a longer one as a cut', () => {
    expect(
      limitFor('scale', 'status.check_interval_seconds', {
        overrides: overrides({ 'status.check_interval_seconds': 10 }),
      }),
    ).toBe(10);
    expectEntitlementError(
      () =>
        limitFor('scale', 'status.check_interval_seconds', {
          overrides: overrides({ 'status.check_interval_seconds': 60 }),
        }),
      'ENTITLEMENT_OVERRIDE_LOWERS_LIMIT',
    );
  });

  const invalid: [string, unknown][] = [
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Infinity],
    ['a negative', -1],
    ['one past the largest safe integer', Number.MAX_SAFE_INTEGER + 1],
    ['a numeric string', '1000000'],
    ['null', null],
    ['a bigint', 1_000_000n],
    ['a boxed number', Object(1_000_000)],
    ['the string unlimited in the wrong case', 'UNLIMITED'],
  ];
  for (const [label, value] of invalid) {
    it(`refuses ${label} as an override value with ENTITLEMENT_INVALID_OVERRIDE`, () => {
      expectEntitlementError(
        () =>
          limitFor('enterprise', 'status.monitors', {
            overrides: overrides({ 'status.monitors': value }),
          }),
        'ENTITLEMENT_INVALID_OVERRIDE',
      );
    });
  }

  it('refuses an override for an unknown key', () => {
    expectEntitlementError(
      () => limitFor('enterprise', 'org.seats', { overrides: overrides({ 'org.seat': 50 }) }),
      'ENTITLEMENT_UNKNOWN_LIMIT',
    );
  });

  it('refuses a __proto__ key that arrived through JSON', () => {
    const fromJson = JSON.parse('{"__proto__": 5}') as Record<string, unknown>;
    expectEntitlementError(
      () => limitFor('enterprise', 'org.seats', { overrides: overrides(fromJson) }),
      'ENTITLEMENT_UNKNOWN_LIMIT',
    );
  });

  it('ignores keys inherited through the prototype chain', () => {
    const inherited = Object.create({ 'status.monitors': 5 }) as Record<string, unknown>;
    expect(limitFor('enterprise', 'status.monitors', { overrides: overrides(inherited) })).toBe(
      limitFor('enterprise', 'status.monitors'),
    );
  });

  it('does not mutate the overrides it is given', () => {
    const input = Object.freeze({ 'status.monitors': 5000 });
    expect(limitFor('enterprise', 'status.monitors', { overrides: overrides(input) })).toBe(5000);
    expect(input).toEqual({ 'status.monitors': 5000 });
  });

  it('treats an empty override map as the table', () => {
    for (const key of pricing.LIMIT_KEYS) {
      expect(limitFor('enterprise', key, { overrides: overrides({}) })).toBe(
        limitFor('enterprise', key),
      );
    }
  });

  it('never lets one organization see another one overrides', () => {
    const contract = overrides({ 'status.monitors': 5000 });
    expect(limitFor('enterprise', 'status.monitors', { overrides: contract })).toBe(5000);
    expect(checkLimit('enterprise', 'status.monitors', 5000).status).toBe(
      checkLimit('enterprise', 'status.monitors', 5000, { overrides: overrides({}) }).status,
    );
    expect(limitFor('enterprise', 'status.monitors')).not.toBe(5000);
  });
});

describe('override properties', () => {
  const tierArb = fc.constantFrom(...(pricing.TIERS as readonly Tier[]));
  const keyArb = fc.constantFrom(...(pricing.LIMIT_KEYS as readonly LimitKey[]));
  const valueArb = fc.oneof(
    fc.constant(UNLIMITED),
    fc.nat({ max: 2_000_000 }),
    fc.constant(Number.MAX_SAFE_INTEGER),
  );

  it('applies a value exactly when it is at least as generous as the table', () => {
    fc.assert(
      fc.property(tierArb, keyArb, valueArb, (t, k, value) => {
        const base = limitFor(t, k);
        const options = { overrides: overrides({ [k]: value }) };
        const code = caughtCode(() => limitFor(t, k, options));
        if (atLeastAsGenerous(limitInfo(k).direction, value, base)) {
          return code === undefined && limitFor(t, k, options) === value;
        }
        return code === 'ENTITLEMENT_OVERRIDE_LOWERS_LIMIT';
      }),
      RUNS,
    );
  });

  it('never leaves a limit less generous than the table', () => {
    fc.assert(
      fc.property(tierArb, keyArb, valueArb, (t, k, value) => {
        const options = { overrides: overrides({ [k]: value }) };
        if (caughtCode(() => limitFor(t, k, options)) !== undefined) return true;
        return atLeastAsGenerous(limitInfo(k).direction, limitFor(t, k, options), limitFor(t, k));
      }),
      RUNS,
    );
  });

  it('never changes a later check that passes no overrides', () => {
    const step = fc.tuple(tierArb, keyArb, valueArb, fc.nat({ max: 2_000_000 }));
    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 20 }), (steps) => {
        for (const [t, k, value, usage] of steps) {
          const before = checkLimit(t, k, usage);
          caughtCode(() => checkLimit(t, k, usage, { overrides: overrides({ [k]: value }) }));
          expect(checkLimit(t, k, usage)).toEqual(before);
        }
      }),
      RUNS,
    );
  });
});
