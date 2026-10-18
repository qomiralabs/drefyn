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

  it('is the string unlimited, the form stored overrides and API responses carry', () => {
    expect(UNLIMITED).toBe('unlimited');
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

    const grace = (pricing.SEND_KEYS as readonly string[]).includes(key);
    it(`${key} has scope ${row.scope}, direction ${row.direction} and grace ${grace}`, () => {
      expect(limitInfo(key as LimitKey)).toEqual({
        key,
        scope: row.scope,
        direction: row.direction,
        grace,
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
        const expected = cell.atLeast ?? cell.atMost ?? 0;
        it(`${tier} ${key} is a listed placeholder that resolves to ${expected}`, () => {
          const value = limitFor(tier as Tier, key as LimitKey);
          expect(isLimitValue(value)).toBe(true);
          expect(UNCALIBRATED.some((entry) => entry.tier === tier && entry.key === key)).toBe(true);
          // The most generous value the pricing proves, and no more.
          expect(value).toBe(expected);
        });
      }
    }
  }
});

describe('send grace', () => {
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

    it(`${feature} has scope ${row.scope}, since ${row.since}, open core ${row.selfHosted}`, () => {
      expect(featureInfo(feature as FeatureKey)).toEqual({
        feature,
        scope: row.scope,
        since: row.since,
        openCore: row.selfHosted,
      });
    });

    pricing.HOSTED_LADDER.forEach((tier, index) => {
      const expected = index >= since;
      it(`${tier} ${expected ? 'has' : 'does not have'} ${feature}`, () => {
        expect(hasFeature(tier, feature as FeatureKey)).toBe(expected);
      });
    });

    it(`self_hosted ${row.selfHosted ? 'has' : 'does not have'} ${feature}`, () => {
      expect(hasFeature('self_hosted', feature as FeatureKey)).toBe(row.selfHosted);
    });
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

  it('carries the value limitFor returns today for each entry', () => {
    expect(UNCALIBRATED.length).toBeGreaterThan(0);
    for (const entry of UNCALIBRATED) {
      expect(entry.value, id(entry)).toBe(limitFor(entry.tier, entry.key));
    }
  });

  it('states the basis of each value, matching the bound the pricing gives', () => {
    for (const cell of pricing.placeholderCells()) {
      const row: pricing.LimitRow = pricing.LIMITS[cell.key];
      const bounds = row.cells[cell.tier] as pricing.Placeholder;
      const entry = UNCALIBRATED.find((e) => e.tier === cell.tier && e.key === cell.key);
      expect(entry, id(cell)).toBeDefined();
      const basis =
        bounds.atLeast !== undefined
          ? 'at_least'
          : bounds.atMost !== undefined
            ? 'at_most'
            : 'unset';
      expect(entry?.basis, id(cell)).toBe(basis);
    }
  });

  it('resolves every unset entry to 0, so nothing runs on a forgotten guess', () => {
    const unset = UNCALIBRATED.filter((entry) => entry.basis === 'unset');
    expect(unset.map(id).sort()).toEqual(
      pricing
        .placeholderCells()
        .filter((c) => {
          const bounds = (pricing.LIMITS[c.key] as pricing.LimitRow).cells[
            c.tier
          ] as pricing.Placeholder;
          return bounds.atLeast === undefined && bounds.atMost === undefined;
        })
        .map(id)
        .sort(),
    );
    for (const entry of unset) {
      expect(entry.value, id(entry)).toBe(0);
      expect(limitFor(entry.tier, entry.key), id(entry)).toBe(0);
    }
  });

  it('leaves hosted Studio caps at 0 until they are calibrated', () => {
    for (const tier of pricing.HOSTED_LADDER) {
      for (const key of [
        'studio.items',
        'studio.assets',
        'studio.api_requests_per_month',
      ] as const) {
        expect(limitFor(tier, key), `${tier} ${key}`).toBe(0);
      }
    }
  });
});
