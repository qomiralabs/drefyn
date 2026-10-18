import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  FEATURE_KEYS,
  LIMIT_KEYS,
  PRODUCTS,
  TIERS,
  UNLIMITED,
  checkLimit,
  entitlementsFor,
  graceAllowance,
  hasFeature,
  limitFor,
  limitInfo,
} from '../src/index.ts';
import type { FeatureKey, LimitKey, Tier } from '../src/index.ts';
import * as pricing from './fixtures/pricing.ts';
import { RUNS, atLeastAsGenerous, caughtCode, isLimitValue } from './support/assert.ts';

// Arbitraries come from the fixture, not the package, so an empty or wrong export list
// cannot make a property pass by giving it nothing to check.
const tierArb = fc.constantFrom(...(pricing.TIERS as readonly Tier[]));
const keyArb = fc.constantFrom(...(pricing.LIMIT_KEYS as readonly LimitKey[]));
const featureArb = fc.constantFrom(...(pricing.FEATURE_KEYS as readonly FeatureKey[]));
const sendKeyArb = fc.constantFrom(...(pricing.SEND_KEYS as readonly LimitKey[]));
const ladderPairArb = fc
  .tuple(
    fc.integer({ min: 0, max: pricing.HOSTED_LADDER.length - 1 }),
    fc.integer({ min: 0, max: pricing.HOSTED_LADDER.length - 1 }),
  )
  .map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as const)
  .map(
    ([lo, hi]) => [pricing.HOSTED_LADDER[lo] as Tier, pricing.HOSTED_LADDER[hi] as Tier] as const,
  );

// Small counts, counts near every real limit and huge counts, so boundaries get hit.
const nearLimits = pricing.LIMIT_KEYS.flatMap((k) =>
  pricing.TIERS.map((t) => (pricing.LIMITS[k] as pricing.LimitRow).cells[t]),
).filter((cell): cell is number => typeof cell === 'number');
const usageArb = fc.oneof(
  fc.nat({ max: 20 }),
  fc.constantFrom(...nearLimits).chain((n) => fc.integer({ min: Math.max(0, n - 2), max: n + 2 })),
  fc.integer({ min: 0, max: 2_000_000 }),
  fc.constantFrom(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1),
);

describe('every limit is a non negative safe integer or the unlimited value', () => {
  it('holds for every tier and key', () => {
    fc.assert(
      fc.property(tierArb, keyArb, (t, k) => isLimitValue(limitFor(t, k))),
      RUNS,
    );
  });

  it('holds exhaustively, not just for sampled pairs', () => {
    for (const t of pricing.TIERS) {
      for (const k of pricing.LIMIT_KEYS) {
        expect(isLimitValue(limitFor(t, k)), `${t} ${k}`).toBe(true);
      }
    }
  });

  it('holds for grace allowances', () => {
    fc.assert(
      fc.property(tierArb, keyArb, (t, k) => isLimitValue(graceAllowance(t, k))),
      RUNS,
    );
  });

  it('returns only integers in every check result', () => {
    fc.assert(
      fc.property(tierArb, keyArb, usageArb, fc.boolean(), (t, k, usage, graceEligible) => {
        const result = checkLimit(t, k, usage, { graceEligible }) as unknown as Record<
          string,
          unknown
        >;
        for (const field of ['limit', 'usage', 'excess'] as const) {
          if (field in result && result[field] !== UNLIMITED) {
            expect(Number.isSafeInteger(result[field]), field).toBe(true);
            expect(result[field] as number).toBeGreaterThanOrEqual(0);
          }
        }
      }),
      RUNS,
    );
  });
});

describe('one plan answers the same in every product', () => {
  it('gives the same check result through Docs, Studio and Status', () => {
    fc.assert(
      fc.property(tierArb, keyArb, usageArb, fc.boolean(), (t, k, usage, graceEligible) => {
        const direct = checkLimit(t, k, usage, { graceEligible });
        for (const product of PRODUCTS) {
          expect(entitlementsFor(product).checkLimit(t, k, usage, { graceEligible })).toEqual(
            direct,
          );
        }
      }),
      RUNS,
    );
  });

  it('gives the same limit and feature answers through every product', () => {
    fc.assert(
      fc.property(tierArb, keyArb, featureArb, (t, k, feat) => {
        for (const product of PRODUCTS) {
          const api = entitlementsFor(product);
          expect(api.limitFor(t, k)).toEqual(limitFor(t, k));
          expect(api.hasFeature(t, feat)).toBe(hasFeature(t, feat));
        }
      }),
      RUNS,
    );
  });

  it('fails the same way through every product for bad input', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.anything(), (t, k, usage) => {
        const direct = caughtCode(() => checkLimit(t as Tier, k as LimitKey, usage as number));
        for (const product of PRODUCTS) {
          expect(
            caughtCode(() =>
              entitlementsFor(product).checkLimit(t as Tier, k as LimitKey, usage as number),
            ),
          ).toBe(direct);
        }
      }),
      RUNS,
    );
  });

  it('agrees on send caps for every tier whichever product asks', () => {
    for (const t of pricing.TIERS) {
      for (const k of pricing.SEND_KEYS) {
        const answers = PRODUCTS.map((p) => entitlementsFor(p).limitFor(t, k));
        expect(new Set(answers).size, `${t} ${k}`).toBe(1);
      }
    }
  });
});

describe('a dearer tier is never worse', () => {
  it('never has a less generous limit than a cheaper hosted tier', () => {
    fc.assert(
      fc.property(ladderPairArb, keyArb, ([lo, hi], k) =>
        atLeastAsGenerous(limitInfo(k).direction, limitFor(hi, k), limitFor(lo, k)),
      ),
      RUNS,
    );
  });

  it('holds exhaustively over every adjacent pair', () => {
    for (let i = 1; i < pricing.HOSTED_LADDER.length; i += 1) {
      const lo = pricing.HOSTED_LADDER[i - 1] as Tier;
      const hi = pricing.HOSTED_LADDER[i] as Tier;
      for (const k of pricing.LIMIT_KEYS) {
        const direction = limitInfo(k).direction;
        expect(
          atLeastAsGenerous(direction, limitFor(hi, k), limitFor(lo, k)),
          `${hi} ${k} vs ${lo}`,
        ).toBe(true);
      }
    }
  });

  it('never has fewer features than a cheaper hosted tier', () => {
    fc.assert(
      fc.property(
        ladderPairArb,
        featureArb,
        ([lo, hi], feat) => !hasFeature(lo, feat) || hasFeature(hi, feat),
      ),
      RUNS,
    );
  });

  it('never refuses usage that a cheaper hosted tier allows', () => {
    fc.assert(
      fc.property(
        ladderPairArb,
        keyArb,
        usageArb,
        ([lo, hi], k, usage) =>
          checkLimit(lo, k, usage).status !== 'allowed' ||
          checkLimit(hi, k, usage).status === 'allowed',
      ),
      RUNS,
    );
  });

  it('keeps self_hosted at least as generous as every hosted tier', () => {
    fc.assert(
      fc.property(tierArb, keyArb, (t, k) =>
        atLeastAsGenerous(limitInfo(k).direction, limitFor('self_hosted', k), limitFor(t, k)),
      ),
      RUNS,
    );
  });
});

describe('checks are consistent in usage', () => {
  it('allows every smaller usage when a max limit allows a usage', () => {
    fc.assert(
      fc.property(tierArb, keyArb, usageArb, fc.nat(), (t, k, usage, delta) => {
        fc.pre(limitInfo(k).direction === 'max');
        const smaller = Math.max(0, usage - delta);
        return (
          checkLimit(t, k, usage).status !== 'allowed' ||
          checkLimit(t, k, smaller).status === 'allowed'
        );
      }),
      RUNS,
    );
  });

  it('allows usage exactly when it is within the limit', () => {
    fc.assert(
      fc.property(tierArb, keyArb, usageArb, (t, k, usage) => {
        const limit = limitFor(t, k);
        const allowed = checkLimit(t, k, usage).status === 'allowed';
        if (limit === UNLIMITED) return allowed;
        return limitInfo(k).direction === 'max'
          ? allowed === usage <= limit
          : allowed === usage >= limit;
      }),
      RUNS,
    );
  });

  it('marks every refusal read only and never throws for valid usage', () => {
    fc.assert(
      fc.property(tierArb, keyArb, usageArb, fc.boolean(), (t, k, usage, graceEligible) => {
        const result = checkLimit(t, k, usage, { graceEligible });
        expect(['allowed', 'over_limit', 'not_entitled']).toContain(result.status);
        if (result.status !== 'allowed') {
          expect(result).toMatchObject({ access: 'read_only' });
        }
      }),
      RUNS,
    );
  });

  it('gives the same answer every time, whatever was asked before', () => {
    const query = fc.tuple(tierArb, keyArb, usageArb, fc.boolean());
    fc.assert(
      fc.property(fc.array(query, { minLength: 1, maxLength: 30 }), (queries) => {
        const first = queries.map(([t, k, u, o]) => checkLimit(t, k, u, { graceEligible: o }));
        const again = [...queries]
          .reverse()
          .map(([t, k, u, o]) => checkLimit(t, k, u, { graceEligible: o }))
          .reverse();
        expect(again).toEqual(first);
      }),
      RUNS,
    );
  });
});

describe('send caps never allow a send past cap plus grace', () => {
  it('holds for a grace eligible send', () => {
    fc.assert(
      fc.property(tierArb, sendKeyArb, usageArb, (t, k, usage) => {
        const cap = limitFor(t, k);
        if (checkLimit(t, k, usage, { graceEligible: true }).status !== 'allowed') return true;
        if (cap === UNLIMITED) return true;
        return usage <= cap + Math.floor((cap * 25) / 100);
      }),
      RUNS,
    );
  });

  it('holds for a send that is not grace eligible, where the cap itself is the ceiling', () => {
    fc.assert(
      fc.property(tierArb, sendKeyArb, usageArb, (t, k, usage) => {
        const cap = limitFor(t, k);
        if (checkLimit(t, k, usage).status !== 'allowed') return true;
        return cap === UNLIMITED || usage <= cap;
      }),
      RUNS,
    );
  });

  it('uses the whole grace and not one send more', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...(pricing.HOSTED_LADDER as readonly Tier[])),
        sendKeyArb,
        (t, k) => {
          const cap = limitFor(t, k);
          if (cap === UNLIMITED || cap === 0) return true;
          const ceiling = cap + (graceAllowance(t, k) as number);
          return (
            checkLimit(t, k, ceiling, { graceEligible: true }).status === 'allowed' &&
            checkLimit(t, k, ceiling + 1, { graceEligible: true }).status !== 'allowed'
          );
        },
      ),
      RUNS,
    );
  });

  it('only ever widens what is allowed, and only on send keys', () => {
    fc.assert(
      fc.property(tierArb, keyArb, usageArb, (t, k, usage) => {
        const plain = checkLimit(t, k, usage).status;
        const open = checkLimit(t, k, usage, { graceEligible: true }).status;
        const sendKeys: readonly string[] = pricing.SEND_KEYS;
        if (!sendKeys.includes(k)) return plain === open;
        return plain !== 'allowed' || open === 'allowed';
      }),
      RUNS,
    );
  });
});

describe('fuzzed input fails closed', () => {
  const knownTiers: readonly string[] = pricing.TIERS;
  const knownKeys: readonly string[] = pricing.LIMIT_KEYS;
  const knownFeatures: readonly string[] = pricing.FEATURE_KEYS;

  it('rejects any string that is not a tier', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (t) => {
        fc.pre(!knownTiers.includes(t));
        return caughtCode(() => limitFor(t as Tier, 'org.seats')) === 'ENTITLEMENT_UNKNOWN_TIER';
      }),
      RUNS,
    );
  });

  it('rejects any string that is not a limit key', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (k) => {
        fc.pre(!knownKeys.includes(k));
        return caughtCode(() => limitFor('scale', k as LimitKey)) === 'ENTITLEMENT_UNKNOWN_LIMIT';
      }),
      RUNS,
    );
  });

  it('rejects any string that is not a feature', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (feat) => {
        fc.pre(!knownFeatures.includes(feat));
        return (
          caughtCode(() => hasFeature('scale', feat as FeatureKey)) ===
          'ENTITLEMENT_UNKNOWN_FEATURE'
        );
      }),
      RUNS,
    );
  });

  it('accepts usage only when it is a non negative safe integer', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.anything(),
          fc.double(),
          fc.integer({ min: -1_000_000, max: -1 }),
          fc.double({ min: 2 ** 53, max: 1e300, noNaN: true }),
        ),
        tierArb,
        keyArb,
        (usage, t, k) => {
          const valid = typeof usage === 'number' && Number.isSafeInteger(usage) && usage >= 0;
          const code = caughtCode(() => checkLimit(t, k, usage as number));
          return valid ? code === undefined : code === 'ENTITLEMENT_INVALID_USAGE';
        },
      ),
      RUNS,
    );
  });

  it('keeps the exported key lists in step with the fixture used by these properties', () => {
    expect([...TIERS].sort()).toEqual([...pricing.TIERS].sort());
    expect([...LIMIT_KEYS].sort()).toEqual([...pricing.LIMIT_KEYS].sort());
    expect([...FEATURE_KEYS].sort()).toEqual([...pricing.FEATURE_KEYS].sort());
  });
});
