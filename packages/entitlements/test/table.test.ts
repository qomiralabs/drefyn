import { describe, expect, it } from 'vitest';
import {
  FEATURE_KEYS,
  LIMIT_KEYS,
  PRODUCTS,
  TIERS,
  UNCALIBRATED,
  UNLIMITED,
  featureInfo,
  graceAllowance,
  hasFeature,
  limitFor,
  limitInfo,
} from '../src/index.ts';
import type { FeatureKey, LimitKey, Tier } from '../src/index.ts';
import * as pricing from './fixtures/pricing.ts';
import { isLimitValue } from './support/assert.ts';

const sorted = (values: readonly string[]) => [...values].sort();

describe('tiers, products and keys', () => {
  it('has exactly the six tiers, cheapest first, self_hosted last', () => {
    expect(TIERS).toEqual(pricing.TIERS);
  });

  it('has exactly the three products', () => {
    expect(PRODUCTS).toEqual(pricing.PRODUCTS);
  });

  it('has exactly the limit keys in the pricing, no more and no fewer', () => {
    expect(sorted(LIMIT_KEYS)).toEqual(sorted(pricing.LIMIT_KEYS));
  });

  it('has exactly the feature keys in the pricing, no more and no fewer', () => {
    expect(sorted(FEATURE_KEYS)).toEqual(sorted(pricing.FEATURE_KEYS));
  });

  it('lists every key once', () => {
    expect(new Set(LIMIT_KEYS).size).toBe(LIMIT_KEYS.length);
    expect(new Set(FEATURE_KEYS).size).toBe(FEATURE_KEYS.length);
  });

  it('freezes the exported lists so a caller cannot add a tier or key at run time', () => {
    for (const list of [TIERS, PRODUCTS, LIMIT_KEYS, FEATURE_KEYS, UNCALIBRATED]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
    expect(() => (TIERS as unknown as string[]).push('pro')).toThrow(TypeError);
    expect(TIERS).toHaveLength(6);
  });
});

describe('the unlimited value', () => {
  it('is not a number, so it can never be compared or added as one', () => {
    expect(UNLIMITED).toBeDefined();
    expect(typeof UNLIMITED).not.toBe('number');
    expect(UNLIMITED).not.toBe(Infinity);
  });

  it('survives a JSON round trip unchanged, unlike Infinity or a symbol', () => {
    // toEqual would let an undefined value vanish on both sides and pass.
    const roundTripped = JSON.parse(JSON.stringify({ limit: UNLIMITED })) as object;
    expect(Object.keys(roundTripped)).toEqual(['limit']);
    expect(roundTripped).toStrictEqual({ limit: UNLIMITED });
  });
});

describe('limit table, cell for cell', () => {
  for (const key of pricing.LIMIT_KEYS) {
    const row: pricing.LimitRow = pricing.LIMITS[key];

    it(`${key} has scope ${row.scope} and direction ${row.direction}`, () => {
      expect(limitInfo(key as LimitKey)).toMatchObject({
        scope: row.scope,
        direction: row.direction,
      });
    });

    for (const tier of pricing.TIERS) {
      const cell = row.cells[tier];
      if (cell === 'unlimited') {
        it(`${tier} ${key} is unlimited`, () => {
          expect(limitFor(tier as Tier, key as LimitKey)).toBe(UNLIMITED);
        });
      } else if (typeof cell === 'number') {
        it(`${tier} ${key} is ${cell}`, () => {
          expect(limitFor(tier as Tier, key as LimitKey)).toBe(cell);
        });
      } else {
        it(`${tier} ${key} is a listed placeholder within its bounds`, () => {
          const value = limitFor(tier as Tier, key as LimitKey);
          expect(isLimitValue(value)).toBe(true);
          expect(UNCALIBRATED.some((entry) => entry.tier === tier && entry.key === key)).toBe(true);
          if (cell.atLeast !== undefined && value !== UNLIMITED) {
            expect(value).toBeGreaterThanOrEqual(cell.atLeast);
          }
          if (cell.atMost !== undefined) {
            expect(value).not.toBe(UNLIMITED);
            expect(value).toBeLessThanOrEqual(cell.atMost);
          }
        });
      }
    }
  }
});

describe('send grace for an incident that is already open', () => {
  for (const tier of pricing.HOSTED_LADDER) {
    for (const key of pricing.SEND_KEYS) {
      const expected = pricing.GRACE[tier][key];
      it(`${tier} ${key} grace is ${expected}, a quarter of the cap rounded down`, () => {
        expect(graceAllowance(tier, key)).toBe(expected);
      });
    }
  }

  it('self_hosted has unlimited grace on every send key', () => {
    for (const key of pricing.SEND_KEYS) {
      expect(graceAllowance('self_hosted', key)).toBe(UNLIMITED);
    }
  });

  it('every other limit has no grace', () => {
    const sendKeys: readonly string[] = pricing.SEND_KEYS;
    for (const tier of pricing.TIERS) {
      for (const key of pricing.LIMIT_KEYS.filter((k) => !sendKeys.includes(k))) {
        expect(graceAllowance(tier, key as LimitKey), `${tier} ${key}`).toBe(0);
      }
    }
  });
});

describe('feature table, cell for cell', () => {
  for (const feature of pricing.FEATURE_KEYS) {
    const row: pricing.FeatureRow = pricing.FEATURES[feature];
    const since = pricing.HOSTED_LADDER.indexOf(row.since);

    it(`${feature} has scope ${row.scope}`, () => {
      expect(featureInfo(feature as FeatureKey)).toMatchObject({ scope: row.scope });
    });

    pricing.HOSTED_LADDER.forEach((tier, index) => {
      const expected = index >= since;
      it(`${tier} ${expected ? 'has' : 'does not have'} ${feature}`, () => {
        expect(hasFeature(tier, feature as FeatureKey)).toBe(expected);
      });
    });

    if (row.selfHosted !== 'open') {
      const expected = row.selfHosted;
      it(`self_hosted ${expected ? 'has' : 'does not have'} ${feature}`, () => {
        expect(hasFeature('self_hosted', feature as FeatureKey)).toBe(expected);
        expect(featureInfo(feature as FeatureKey).openCore).toBe(expected);
      });
    }
  }
});

describe('uncalibrated placeholders', () => {
  const id = (entry: { tier: string; key: string }) => `${entry.tier} ${entry.key}`;

  it('lists exactly the cells the pricing leaves open', () => {
    expect(sorted(UNCALIBRATED.map(id))).toEqual(sorted(pricing.placeholderCells().map(id)));
  });

  it('lists each cell once', () => {
    expect(new Set(UNCALIBRATED.map(id)).size).toBe(UNCALIBRATED.length);
  });

  it('never lists a self_hosted cell, which is unlimited by rule, not by guess', () => {
    expect(UNCALIBRATED.filter((entry) => entry.tier === 'self_hosted')).toEqual([]);
  });

  it('freezes each entry', () => {
    for (const entry of UNCALIBRATED) expect(Object.isFrozen(entry)).toBe(true);
  });

  it('points only at known tiers and keys', () => {
    for (const entry of UNCALIBRATED) {
      expect(TIERS).toContain(entry.tier);
      expect(LIMIT_KEYS).toContain(entry.key);
    }
  });
});
