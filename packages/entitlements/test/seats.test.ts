import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LIMIT_KEYS, PRODUCTS, checkLimit, countSeats, limitInfo } from '../src/index.ts';
import type { Product } from '../src/index.ts';
import { RUNS } from './support/assert.ts';

describe('seats are counted once per organization', () => {
  it('has one seat limit, and it belongs to the organization, not a product', () => {
    expect(LIMIT_KEYS.filter((key) => /seat/i.test(key))).toEqual(['org.seats']);
    expect(limitInfo('org.seats').scope).toBe('org');
  });

  it('counts a person who works in all three products as one seat', () => {
    expect(
      countSeats([
        { userId: 'u_1', product: 'docs' },
        { userId: 'u_1', product: 'studio' },
        { userId: 'u_1', product: 'status' },
      ]),
    ).toBe(1);
  });

  it('counts two people as two seats', () => {
    expect(
      countSeats([
        { userId: 'u_1', product: 'docs' },
        { userId: 'u_2', product: 'docs' },
      ]),
    ).toBe(2);
  });

  it('counts nobody as zero seats', () => {
    expect(countSeats([])).toBe(0);
  });

  it('treats user IDs as exact strings, without case folding or trimming', () => {
    expect(
      countSeats([
        { userId: 'u_a', product: 'docs' },
        { userId: 'U_A', product: 'docs' },
        { userId: 'u_a ', product: 'docs' },
      ]),
    ).toBe(3);
  });

  it('accepts any iterable, read once', () => {
    function* members() {
      yield { userId: 'u_1', product: 'docs' as Product };
      yield { userId: 'u_1', product: 'status' as Product };
      yield { userId: 'u_2', product: 'studio' as Product };
    }
    expect(countSeats(members())).toBe(2);
  });

  it('equals the number of distinct people for any membership list', () => {
    const membership = fc.record({
      userId: fc.string({ minLength: 1, maxLength: 4 }),
      product: fc.constantFrom(...(['docs', 'studio', 'status'] as const)),
    });
    fc.assert(
      fc.property(fc.array(membership, { maxLength: 60 }), (list) => {
        return countSeats(list) === new Set(list.map((m) => m.userId)).size;
      }),
      RUNS,
    );
  });

  it('never grows when the same person joins another product', () => {
    const membership = fc.record({
      userId: fc.string({ minLength: 1, maxLength: 4 }),
      product: fc.constantFrom(...(['docs', 'studio', 'status'] as const)),
    });
    fc.assert(
      fc.property(
        fc.array(membership, { minLength: 1, maxLength: 40 }),
        fc.constantFrom(...(['docs', 'studio', 'status'] as const)),
        (list, product) => {
          const existing = list[0];
          if (existing === undefined) return true;
          return countSeats([...list, { userId: existing.userId, product }]) === countSeats(list);
        },
      ),
      RUNS,
    );
  });

  it('checks the seat count against one org limit whichever product invites', () => {
    const seats = countSeats([
      { userId: 'u_1', product: 'docs' },
      { userId: 'u_2', product: 'studio' },
      { userId: 'u_3', product: 'status' },
    ]);
    expect(seats).toBe(3);
    expect(PRODUCTS).toHaveLength(3);
    expect(checkLimit('free', 'org.seats', seats).status).toBe('over_limit');
    expect(checkLimit('starter', 'org.seats', seats).status).toBe('allowed');
  });
});
