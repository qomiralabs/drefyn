// Seats are counted once per organization by the accounts package; here there is one
// seat limit, owned by the organization, that every product checks the same way.
import { describe, expect, it } from 'vitest';
import { LIMIT_KEYS, PRODUCTS, checkLimit, entitlementsFor, limitInfo } from '../src/index.ts';

describe('one seat limit per organization', () => {
  it('has one seat limit, and it belongs to the organization, not a product', () => {
    expect(LIMIT_KEYS.filter((key) => /seat/i.test(key))).toEqual(['org.seats']);
    expect(limitInfo('org.seats').scope).toBe('org');
  });

  it('checks the seat count against one org limit whichever product invites', () => {
    // Three people, one in each product.
    const seats = 3;
    expect(PRODUCTS).toHaveLength(3);
    expect(checkLimit('free', 'org.seats', seats).status).toBe('over_limit');
    expect(checkLimit('starter', 'org.seats', seats).status).toBe('allowed');
    for (const product of PRODUCTS) {
      expect(entitlementsFor(product).checkLimit('free', 'org.seats', seats).status).toBe(
        'over_limit',
      );
      expect(entitlementsFor(product).checkLimit('starter', 'org.seats', seats).status).toBe(
        'allowed',
      );
    }
  });
});
