import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PRODUCTS, checkLimit } from '@drefyn/entitlements';
import { countSeats, type SeatHolder } from '../src/index.ts';
import { runs } from './support.ts';

const member = (userId: string): SeatHolder => ({ kind: 'member', userId });
const invited = (email: string): SeatHolder => ({ kind: 'invitation', email });

// A person working in a product is a project role on their one membership, never a row of
// its own, so these holders are what the database counts.
const memberArb = fc.string({ minLength: 1, maxLength: 4 }).map(member);
const localPart = fc.stringMatching(/^[a-z0-9]{1,6}$/);
const invitationArb = fc
  .tuple(localPart, fc.constantFrom('example.com', 'example.org'))
  .map(([local, domain]) => invited(`${local}@${domain}`));
const holders = fc.array(fc.oneof(memberArb, invitationArb), { maxLength: 60 });

describe('the seat count against the plan caps', () => {
  // Spelled out so a change to the caps has to touch this test as well.
  const plans = fc.constantFrom(
    { tier: 'free', cap: 5 } as const,
    { tier: 'starter', cap: 10 } as const,
  );
  const distinct = (seats: number) => Array.from({ length: seats }, (_, i) => member(`u_${i}`));

  it('allows every count up to the cap and refuses the next one', () => {
    fc.assert(
      fc.property(plans, fc.nat({ max: 30 }), ({ tier, cap }, people) => {
        const used = countSeats(distinct(people));
        const allowed = checkLimit(tier, 'org.seats', used).status === 'allowed';
        return allowed === used <= cap;
      }),
      runs,
    );
  });

  it('never refuses a person already holding a seat in another product', () => {
    fc.assert(
      fc.property(
        plans,
        fc.array(fc.subarray([...PRODUCTS], { minLength: 1 }), { minLength: 1, maxLength: 12 }),
        ({ tier, cap }, people) => {
          const perProduct = people.flatMap((products, i) => products.map(() => member(`u_${i}`)));
          const allowed =
            checkLimit(tier, 'org.seats', countSeats(perProduct)).status === 'allowed';
          return allowed === people.length <= cap;
        },
      ),
      runs,
    );
  });
});

describe('seats are counted once per organization', () => {
  it('project roles in three products never change the count', () => {
    // A join over project roles yields the member once per product; the count must not.
    const assignments = fc.array(
      fc.record({
        userId: fc.string({ minLength: 1, maxLength: 4 }),
        products: fc.subarray([...PRODUCTS], { minLength: 1 }),
      }),
      { maxLength: 40 },
    );
    expect(countSeats(PRODUCTS.map(() => member('u_1')))).toBe(1);
    fc.assert(
      fc.property(assignments, (list) => {
        const perProduct = list.flatMap((a) => a.products.map(() => member(a.userId)));
        const once = list.map((a) => member(a.userId));
        return (
          countSeats(perProduct) === countSeats(once) &&
          countSeats(once) === new Set(list.map((a) => a.userId)).size
        );
      }),
      runs,
    );
  });

  it('counts two people as two seats', () => {
    expect(countSeats([member('u_1'), member('u_2')])).toBe(2);
  });

  it('counts nobody as zero seats', () => {
    expect(countSeats([])).toBe(0);
  });

  it('compares addresses after normalisation and user ids exactly', () => {
    expect(countSeats([member('u_a'), member('U_A'), member('u_a ')])).toBe(3);
    expect(
      countSeats([invited('Person@Example.com'), invited('person@example.com'), invited('x@y.z')]),
    ).toBe(2);
  });

  it('accepts any iterable, read once', () => {
    let reads = 0;
    function* list() {
      reads += 1;
      yield member('u_1');
      yield member('u_1');
      yield invited('a@example.com');
    }
    expect(countSeats(list())).toBe(2);
    expect(reads).toBe(1);
  });

  it('equals memberships plus pending invitations for any list', () => {
    fc.assert(
      fc.property(holders, (list) => {
        const people = new Set(list.flatMap((h) => (h.kind === 'member' ? [h.userId] : [])));
        const addresses = new Set(
          list.flatMap((h) => (h.kind === 'invitation' ? [h.email.toLowerCase()] : [])),
        );
        return countSeats(list) === people.size + addresses.size;
      }),
      runs,
    );
  });

  it('never grows when a member or an invitation is listed again', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(memberArb, invitationArb), { minLength: 1 }), (list) => {
        const again = list[0];
        if (again === undefined) return true;
        return countSeats([...list, again]) === countSeats(list);
      }),
      runs,
    );
  });

  it('refuses a holder it cannot count', () => {
    expect(() => countSeats([invited('not an address')])).toThrow(RangeError);
    expect(() => countSeats([{ kind: 'guest' } as unknown as SeatHolder])).toThrow(RangeError);
  });
});
