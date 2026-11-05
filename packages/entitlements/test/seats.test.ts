// Seats are counted once per organization by the accounts package; here there is one
// seat limit, owned by the organization, that every product checks the same way.
import { describe, expect, it } from 'vitest';
import {
  LIMIT_KEYS,
  PRODUCTS,
  UNLIMITED,
  checkLimit,
  entitlementsFor,
  limitFor,
  limitInfo,
} from '../src/index.ts';

describe('one seat limit per organization', () => {
  it('has one seat limit, and it belongs to the organization, not a product', () => {
    expect(LIMIT_KEYS.filter((key) => /seat/i.test(key))).toEqual(['org.seats']);
    expect(limitInfo('org.seats').scope).toBe('org');
  });

  it('checks the seat count against one org limit whichever product invites', () => {
    // Six people across the products: one over Free, well inside Starter.
    const seats = 6;
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

  it('gives Free 5 seats and refuses a sixth', () => {
    expect(limitFor('free', 'org.seats')).toBe(5);
    expect(checkLimit('free', 'org.seats', 5).status).toBe('allowed');
    expect(checkLimit('free', 'org.seats', 6)).toMatchObject({
      status: 'over_limit',
      limit: 5,
      excess: 1,
    });
  });

  it('gives Starter 10 seats and refuses an eleventh', () => {
    expect(limitFor('starter', 'org.seats')).toBe(10);
    expect(checkLimit('starter', 'org.seats', 10).status).toBe('allowed');
    expect(checkLimit('starter', 'org.seats', 11)).toMatchObject({
      status: 'over_limit',
      limit: 10,
      excess: 1,
    });
  });

  it('keeps the seats above Starter where they were', () => {
    expect(limitFor('growth', 'org.seats')).toBe(20);
    expect(limitFor('scale', 'org.seats')).toBe(UNLIMITED);
    expect(limitFor('enterprise', 'org.seats')).toBe(UNLIMITED);
    expect(limitFor('self_hosted', 'org.seats')).toBe(UNLIMITED);
  });

  it('leaves a team that outgrew the plan read only, with nobody dropped', () => {
    // A downgrade from Growth keeps all twenty seats in the answer.
    expect(checkLimit('starter', 'org.seats', 20)).toMatchObject({
      status: 'over_limit',
      usage: 20,
      excess: 10,
      access: 'read_only',
    });
  });
});
