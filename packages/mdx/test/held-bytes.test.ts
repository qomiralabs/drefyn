import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createHeldBytes } from '../src/held-bytes.ts';

describe('held bytes', () => {
  it('lets an organization hold up to a quarter and no more', () => {
    const held = createHeldBytes(400);
    const claim = held.claim('a');
    expect(claim.take(100)).toBe(true);
    expect(claim.take(1)).toBe(false);
    expect(held.claim('a').take(1)).toBe(false);
  });

  it('keeps a refused claim out of the count', () => {
    const held = createHeldBytes(400);
    expect(held.claim('a').take(101)).toBe(false);
    expect(held.claim('a').take(100)).toBe(true);
  });

  it('caps the host across organizations', () => {
    const held = createHeldBytes(400);
    for (const org of ['a', 'b', 'c']) expect(held.claim(org).take(100)).toBe(true);
    expect(held.claim('d').take(101)).toBe(false);
    expect(held.bytes()).toBe(300);
  });

  it('never lets one organization hold more than stays free beside it', () => {
    const held = createHeldBytes(400);
    for (const org of ['a', 'b', 'c']) held.claim(org).take(100);
    expect(held.claim('d').take(51)).toBe(false);
    expect(held.claim('d').take(50)).toBe(true);
    expect(held.claim('e').take(26)).toBe(false);
    expect(held.claim('e').take(25)).toBe(true);
  });

  it('leaves room however many organizations act together', () => {
    const held = createHeldBytes(268_435_456);
    for (let org = 0; org < 12; org += 1) {
      const claim = held.claim(String(org));
      for (let chunk = 0; chunk < 4_000 && claim.take(65_536); chunk += 1);
    }
    expect(held.claim('honest').fits(6_000)).toBe(true);
  });

  it('gives bytes back once, however many times a claim is released', () => {
    const held = createHeldBytes(400);
    const claim = held.claim('a');
    claim.take(100);
    claim.release();
    held.claim('a').take(100);
    claim.release();
    expect(held.claim('a').take(1)).toBe(false);
    expect(held.bytes()).toBe(100);
  });

  it('can say whether a declared size would fit, without taking it', () => {
    const held = createHeldBytes(400);
    const claim = held.claim('a');
    expect(claim.fits(100)).toBe(true);
    expect(claim.fits(101)).toBe(false);
    expect(held.bytes()).toBe(0);
    claim.take(60);
    expect(claim.fits(40)).toBe(true);
    expect(claim.fits(41)).toBe(false);
  });

  it('sees the whole host in what fits', () => {
    const held = createHeldBytes(400);
    for (const org of ['a', 'b', 'c']) held.claim(org).take(100);
    expect(held.claim('e').fits(50)).toBe(true);
    expect(held.claim('e').fits(51)).toBe(false);
  });

  it('forgets an organization that holds nothing', () => {
    const held = createHeldBytes(400);
    const claim = held.claim('a');
    claim.take(1);
    expect(held.organizations()).toBe(1);
    claim.release();
    expect(held.organizations()).toBe(0);
  });

  it('never passes its limits, and ends at zero', () => {
    const step = fc.record({
      org: fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f'),
      bytes: fc.nat(150),
    });
    fc.assert(
      fc.property(fc.array(step, { maxLength: 60 }), (steps) => {
        const held = createHeldBytes(400);
        const claims = steps.map(({ org, bytes }) => {
          const claim = held.claim(org);
          claim.take(bytes);
          expect(held.bytes()).toBeLessThanOrEqual(400);
          return claim;
        });
        for (const claim of claims) claim.release();
        expect(held.bytes()).toBe(0);
        expect(held.organizations()).toBe(0);
      }),
    );
  });
});
