// Usage passed to checkLimit is the amount that would be in use with the action being
// checked: 3 projects in total, the 2,001st email this month, a 30 second interval.
// A max limit allows usage up to and including the limit; a min limit (the check
// interval floor) allows usage at or above it. A refusal never implies deletion: it
// carries access 'read_only' so existing content stays and only stops being editable.
// Grace widens a send cap by a quarter only when the caller marks the send grace
// eligible; every result reports the grace it applied, and excess is measured past
// limit plus grace.
import { describe, expect, it } from 'vitest';
import {
  FEATURE_KEYS,
  LIMIT_KEYS,
  PRODUCTS,
  TIERS,
  UNLIMITED,
  checkLimit,
  entitlementsFor,
  featureInfo,
  graceAllowance,
  hasFeature,
  limitFor,
  limitInfo,
} from '../src/index.ts';
import type { FeatureKey, LimitKey, Product, Tier } from '../src/index.ts';
import { expectEntitlementError } from './support/assert.ts';

const tier = (value: unknown) => value as Tier;
const key = (value: unknown) => value as LimitKey;
const feature = (value: unknown) => value as FeatureKey;
// JSON.stringify returns undefined for undefined, which would collide in test names.
const show = (value: unknown): string =>
  value === undefined ? 'undefined' : JSON.stringify(value);

describe('checkLimit at the boundary', () => {
  it('allows usage equal to the limit', () => {
    expect(checkLimit('free', 'org.seats', 2)).toMatchObject({
      status: 'allowed',
      tier: 'free',
      key: 'org.seats',
      limit: 2,
      usage: 2,
      grace: 0,
    });
  });

  it('refuses one past the limit as over limit, read only', () => {
    expect(checkLimit('free', 'org.seats', 3)).toMatchObject({
      status: 'over_limit',
      tier: 'free',
      key: 'org.seats',
      limit: 2,
      usage: 3,
      grace: 0,
      excess: 1,
      access: 'read_only',
    });
  });

  it('allows zero usage on every key of every tier', () => {
    for (const t of TIERS) {
      for (const k of LIMIT_KEYS) {
        if (limitInfo(k).direction === 'min') continue;
        expect(checkLimit(t, k, 0).status, `${t} ${k}`).toBe('allowed');
      }
    }
  });

  it('reports a zero limit as not entitled, still read only', () => {
    expect(checkLimit('free', 'status.private_probes', 1)).toMatchObject({
      status: 'not_entitled',
      limit: 0,
      usage: 1,
      access: 'read_only',
    });
    expect(checkLimit('free', 'status.sms_sends_per_month', 1).status).toBe('not_entitled');
    expect(checkLimit('starter', 'status.voice_minutes_per_month', 1).status).toBe('not_entitled');
    expect(checkLimit('free', 'org.private_status_pages', 1).status).toBe('not_entitled');
  });

  it('treats the check interval as a floor', () => {
    expect(checkLimit('free', 'status.check_interval_seconds', 180).status).toBe('allowed');
    expect(checkLimit('free', 'status.check_interval_seconds', 600).status).toBe('allowed');
    expect(checkLimit('free', 'status.check_interval_seconds', 179)).toMatchObject({
      status: 'over_limit',
      limit: 180,
      usage: 179,
      access: 'read_only',
    });
    expect(checkLimit('growth', 'status.check_interval_seconds', 30).status).toBe('allowed');
    expect(checkLimit('scale', 'status.check_interval_seconds', 29).status).toBe('over_limit');
  });

  it('allows any usage against an unlimited limit, up to the largest safe integer', () => {
    expect(checkLimit('scale', 'org.seats', Number.MAX_SAFE_INTEGER)).toMatchObject({
      status: 'allowed',
      limit: UNLIMITED,
      usage: Number.MAX_SAFE_INTEGER,
    });
  });

  it('computes excess without overflow at the largest safe integer', () => {
    const result = checkLimit('free', 'docs.pages', Number.MAX_SAFE_INTEGER);
    expect(result).toMatchObject({
      status: 'over_limit',
      excess: Number.MAX_SAFE_INTEGER - 50,
    });
  });

  it('accepts negative zero as zero', () => {
    expect(checkLimit('free', 'docs.pages', -0).status).toBe('allowed');
  });
});

describe('downgrades never delete', () => {
  it('turns docs projects over the new limit read only after Growth to Free', () => {
    expect(checkLimit('growth', 'org.docs_projects', 3).status).toBe('allowed');
    expect(checkLimit('free', 'org.docs_projects', 3)).toMatchObject({
      status: 'over_limit',
      limit: 1,
      usage: 3,
      excess: 2,
      access: 'read_only',
    });
  });

  it('turns monitors over the new limit read only after Scale to Growth', () => {
    expect(checkLimit('growth', 'status.monitors', 1000)).toMatchObject({
      status: 'over_limit',
      excess: 800,
      access: 'read_only',
    });
  });

  it('keeps a 30 second monitor, read only, after Growth to Free', () => {
    expect(checkLimit('free', 'status.check_interval_seconds', 30)).toMatchObject({
      status: 'over_limit',
      access: 'read_only',
    });
  });

  it('keeps private probes, read only, after Growth to Free where the limit is zero', () => {
    expect(checkLimit('free', 'status.private_probes', 5)).toMatchObject({
      status: 'not_entitled',
      access: 'read_only',
    });
  });

  it('keeps seats, read only, after Scale (unlimited) to Free', () => {
    expect(checkLimit('free', 'org.seats', 40)).toMatchObject({
      status: 'over_limit',
      excess: 38,
      access: 'read_only',
    });
  });

  it('returns a value, never throws, for a valid over limit check', () => {
    expect(() => checkLimit('free', 'status.monitors', 1_000_000)).not.toThrow();
  });

  it('never says delete, remove or purge in any result', () => {
    const results = [
      checkLimit('free', 'org.docs_projects', 3),
      checkLimit('free', 'status.private_probes', 5),
      checkLimit('free', 'status.check_interval_seconds', 30),
    ];
    for (const result of results) {
      expect(result).not.toBeInstanceOf(Error);
      expect(JSON.stringify(result)).not.toMatch(/delet|remov|purg|destroy|drop/i);
    }
  });

  it('allows the same usage again after an upgrade, because a check holds no state', () => {
    expect(checkLimit('free', 'org.docs_projects', 3).status).toBe('over_limit');
    expect(checkLimit('growth', 'org.docs_projects', 3).status).toBe('allowed');
    expect(checkLimit('free', 'org.docs_projects', 3).status).toBe('over_limit');
  });

  it('does not let a caller change later answers by mutating a result', () => {
    const first = checkLimit('free', 'org.seats', 3) as unknown as Record<string, unknown>;
    try {
      first['status'] = 'allowed';
      first['limit'] = UNLIMITED;
    } catch {
      // A frozen result is fine too.
    }
    expect(checkLimit('free', 'org.seats', 3).status).toBe('over_limit');
  });
});

describe('send caps and the grace for eligible sends', () => {
  it('stops Free email at 2,000 when the send is not grace eligible', () => {
    expect(checkLimit('free', 'status.email_sends_per_month', 2000).status).toBe('allowed');
    expect(checkLimit('free', 'status.email_sends_per_month', 2001).status).toBe('over_limit');
  });

  it('lets a grace eligible send run 25 percent past the Free email cap and no further', () => {
    const eligible = { graceEligible: true } as const;
    expect(checkLimit('free', 'status.email_sends_per_month', 2500, eligible).status).toBe(
      'allowed',
    );
    expect(checkLimit('free', 'status.email_sends_per_month', 2501, eligible)).toMatchObject({
      status: 'over_limit',
      limit: 2000,
      grace: 500,
      // Measured past limit plus grace, not past the bare cap.
      excess: 1,
      access: 'read_only',
    });
  });

  it('rounds SMS grace down: Starter is 50 plus 12', () => {
    const eligible = { graceEligible: true } as const;
    expect(checkLimit('starter', 'status.sms_sends_per_month', 62, eligible).status).toBe(
      'allowed',
    );
    expect(checkLimit('starter', 'status.sms_sends_per_month', 63, eligible)).toMatchObject({
      status: 'over_limit',
      limit: 50,
      grace: 12,
      excess: 1,
    });
  });

  it('gives no grace where the cap is zero', () => {
    const eligible = { graceEligible: true } as const;
    expect(checkLimit('free', 'status.sms_sends_per_month', 1, eligible).status).toBe(
      'not_entitled',
    );
    expect(graceAllowance('starter', 'status.voice_minutes_per_month')).toBe(0);
  });

  it('ignores the grace option on limits that are not sends', () => {
    const eligible = { graceEligible: true } as const;
    expect(checkLimit('free', 'org.seats', 3, eligible).status).toBe('over_limit');
    expect(checkLimit('free', 'status.monitors', 11, eligible).status).toBe('over_limit');
  });

  it('gives no grace when the grace flag is false', () => {
    expect(
      checkLimit('free', 'status.email_sends_per_month', 2001, { graceEligible: false }),
    ).toMatchObject({ status: 'over_limit', limit: 2000, grace: 0, excess: 1 });
  });

  it('reports the grace it applied on every result', () => {
    const eligible = { graceEligible: true } as const;
    expect(checkLimit('free', 'status.email_sends_per_month', 10)).toMatchObject({
      status: 'allowed',
      grace: 0,
    });
    expect(checkLimit('free', 'status.email_sends_per_month', 10, eligible)).toMatchObject({
      status: 'allowed',
      grace: 500,
    });
    expect(checkLimit('growth', 'status.voice_minutes_per_month', 37, eligible)).toMatchObject({
      status: 'allowed',
      limit: 30,
      grace: 7,
    });
    expect(checkLimit('free', 'status.monitors', 10, eligible)).toMatchObject({
      status: 'allowed',
      grace: 0,
    });
    expect(checkLimit('free', 'status.sms_sends_per_month', 1, eligible)).toMatchObject({
      status: 'not_entitled',
      grace: 0,
    });
    expect(checkLimit('self_hosted', 'status.email_sends_per_month', 10, eligible)).toMatchObject({
      status: 'allowed',
      limit: UNLIMITED,
      grace: UNLIMITED,
    });
  });

  it('measures excess on a send key past limit plus grace', () => {
    const eligible = { graceEligible: true } as const;
    expect(checkLimit('scale', 'status.email_sends_per_month', 62_600, eligible)).toMatchObject({
      status: 'over_limit',
      limit: 50_000,
      grace: 12_500,
      excess: 100,
    });
    expect(checkLimit('scale', 'status.email_sends_per_month', 62_600)).toMatchObject({
      status: 'over_limit',
      limit: 50_000,
      grace: 0,
      excess: 12_600,
    });
  });

  it('keeps components capped at 25 on Free and unlimited on every paid tier', () => {
    expect(checkLimit('free', 'status.components', 26).status).toBe('over_limit');
    for (const t of ['starter', 'growth', 'scale', 'enterprise'] as const) {
      expect(limitFor(t, 'status.components')).toBe(UNLIMITED);
      expect(checkLimit(t, 'status.components', Number.MAX_SAFE_INTEGER).status).toBe('allowed');
    }
  });

  it('keeps subscribers capped at 500 on Free and unlimited on every paid tier', () => {
    expect(checkLimit('free', 'status.subscribers', 501).status).toBe('over_limit');
    for (const t of ['starter', 'growth', 'scale', 'enterprise'] as const) {
      expect(limitFor(t, 'status.subscribers')).toBe(UNLIMITED);
    }
  });
});

describe('usage must be a non negative safe integer', () => {
  const bad: [string, unknown][] = [
    ['a fraction', 1.5],
    ['a float sum', 0.1 + 0.2],
    ['a tiny fraction', Number.EPSILON],
    ['NaN', Number.NaN],
    ['Infinity', Infinity],
    ['minus Infinity', -Infinity],
    ['minus one', -1],
    ['a large negative', -Number.MAX_SAFE_INTEGER],
    ['one past the largest safe integer', Number.MAX_SAFE_INTEGER + 1],
    ['2 to the 53', 2 ** 53],
    ['1e21', 1e21],
    ['a numeric string', '3'],
    ['an empty string', ''],
    ['a bigint', 3n],
    ['a boxed number', Object(3)],
    ['null', null],
    ['undefined', undefined],
    ['true', true],
    ['an array', [3]],
    ['an object with valueOf', { valueOf: () => 3 }],
  ];

  for (const [label, usage] of bad) {
    it(`rejects ${label} with ENTITLEMENT_INVALID_USAGE`, () => {
      expectEntitlementError(
        () => checkLimit('growth', 'docs.pages', usage as number),
        'ENTITLEMENT_INVALID_USAGE',
      );
    });
  }

  it('rejects bad usage even on an unlimited limit, where any number would pass', () => {
    expectEntitlementError(
      () => checkLimit('self_hosted', 'docs.pages', 1.5),
      'ENTITLEMENT_INVALID_USAGE',
    );
    expectEntitlementError(
      () => checkLimit('self_hosted', 'docs.pages', Number.NaN),
      'ENTITLEMENT_INVALID_USAGE',
    );
  });

  it('accepts the largest safe integer', () => {
    expect(() => checkLimit('growth', 'docs.pages', Number.MAX_SAFE_INTEGER)).not.toThrow();
  });
});

describe('unknown input fails closed with a typed error', () => {
  const badTiers: unknown[] = [
    '',
    'FREE',
    'Free',
    ' free',
    'free ',
    'pro',
    'team',
    'self-hosted',
    'selfhosted',
    '__proto__',
    'constructor',
    'toString',
    'hasOwnProperty',
    'valueOf',
    null,
    undefined,
    0,
    {},
    ['free'],
    Object('free'),
  ];

  const badKeys: unknown[] = [
    '',
    'docs',
    'pages',
    'Docs.pages',
    'docs.pages ',
    'docs.pages.extra',
    'docs.Pages',
    'org.seat',
    'docs.seats',
    'studio.seats',
    'status.seats',
    '__proto__',
    'constructor',
    'toString',
    null,
    undefined,
    1,
    {},
  ];

  const badFeatures: unknown[] = [
    '',
    'docs',
    'docs.versioning ',
    'DOCS.VERSIONING',
    'docs.pages',
    '__proto__',
    'constructor',
    'hasOwnProperty',
    null,
    undefined,
    true,
  ];

  const badProducts: unknown[] = ['', 'Docs', 'website', 'dashboard', '__proto__', null, 1];

  for (const value of badTiers) {
    it(`rejects tier ${show(value)} everywhere`, () => {
      expectEntitlementError(
        () => checkLimit(tier(value), 'org.seats', 1),
        'ENTITLEMENT_UNKNOWN_TIER',
      );
      expectEntitlementError(() => limitFor(tier(value), 'org.seats'), 'ENTITLEMENT_UNKNOWN_TIER');
      expectEntitlementError(
        () => hasFeature(tier(value), 'docs.versioning'),
        'ENTITLEMENT_UNKNOWN_TIER',
      );
      expectEntitlementError(
        () => graceAllowance(tier(value), 'status.email_sends_per_month'),
        'ENTITLEMENT_UNKNOWN_TIER',
      );
      for (const product of PRODUCTS) {
        expectEntitlementError(
          () => entitlementsFor(product).checkLimit(tier(value), 'org.seats', 1),
          'ENTITLEMENT_UNKNOWN_TIER',
        );
      }
    });
  }

  for (const value of badKeys) {
    it(`rejects limit key ${show(value)} everywhere`, () => {
      expectEntitlementError(() => checkLimit('scale', key(value), 1), 'ENTITLEMENT_UNKNOWN_LIMIT');
      expectEntitlementError(() => limitFor('scale', key(value)), 'ENTITLEMENT_UNKNOWN_LIMIT');
      expectEntitlementError(() => limitInfo(key(value)), 'ENTITLEMENT_UNKNOWN_LIMIT');
      expectEntitlementError(
        () => graceAllowance('scale', key(value)),
        'ENTITLEMENT_UNKNOWN_LIMIT',
      );
      expectEntitlementError(
        () => checkLimit('self_hosted', key(value), 1),
        'ENTITLEMENT_UNKNOWN_LIMIT',
      );
    });
  }

  for (const value of badFeatures) {
    it(`rejects feature ${show(value)} instead of answering false`, () => {
      expectEntitlementError(
        () => hasFeature('scale', feature(value)),
        'ENTITLEMENT_UNKNOWN_FEATURE',
      );
      expectEntitlementError(
        () => hasFeature('self_hosted', feature(value)),
        'ENTITLEMENT_UNKNOWN_FEATURE',
      );
      expectEntitlementError(() => featureInfo(feature(value)), 'ENTITLEMENT_UNKNOWN_FEATURE');
    });
  }

  for (const value of badProducts) {
    it(`rejects product ${JSON.stringify(value)}`, () => {
      expectEntitlementError(
        () => entitlementsFor(value as Product),
        'ENTITLEMENT_UNKNOWN_PRODUCT',
      );
    });
  }

  it('does not treat a limit key as a feature or a feature as a limit key', () => {
    expectEntitlementError(
      () => hasFeature('scale', feature('org.seats')),
      'ENTITLEMENT_UNKNOWN_FEATURE',
    );
    const someFeature = FEATURE_KEYS[0];
    expect(someFeature).toBeDefined();
    expectEntitlementError(() => limitFor('scale', key(someFeature)), 'ENTITLEMENT_UNKNOWN_LIMIT');
  });

  it('keeps the error code on a readable property and the class name stable', () => {
    const error = expectEntitlementError(
      () => checkLimit(tier('pro'), 'org.seats', 1),
      'ENTITLEMENT_UNKNOWN_TIER',
    );
    expect(error.message).not.toHaveLength(0);
  });

  // Inputs can come from a database row or a request, so messages never echo them.
  it('does not put an unknown tier in the message', () => {
    const error = expectEntitlementError(
      () => checkLimit(tier('pro'), 'org.seats', 1),
      'ENTITLEMENT_UNKNOWN_TIER',
    );
    expect(error.message).not.toContain('pro');
  });

  it('does not echo any rejected input in the message', () => {
    const marker = 'zq7_marker';
    const cases: [() => unknown, Parameters<typeof expectEntitlementError>[1]][] = [
      [() => limitFor(tier(marker), 'org.seats'), 'ENTITLEMENT_UNKNOWN_TIER'],
      [() => limitFor('free', key(marker)), 'ENTITLEMENT_UNKNOWN_LIMIT'],
      [() => hasFeature('free', feature(marker)), 'ENTITLEMENT_UNKNOWN_FEATURE'],
      [() => entitlementsFor(marker as Product), 'ENTITLEMENT_UNKNOWN_PRODUCT'],
    ];
    for (const [run, code] of cases) {
      expect(expectEntitlementError(run, code).message).not.toContain(marker);
    }
    const usage = expectEntitlementError(
      () => checkLimit('free', 'org.seats', 7_654_321.5),
      'ENTITLEMENT_INVALID_USAGE',
    );
    expect(usage.message).not.toContain('7654321');
  });
});
