import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { inFlightLimit } from '../src/in-flight.ts';

describe('inFlightLimit', () => {
  it('lets in up to the cap and no more', () => {
    const limit = inFlightLimit(2);
    expect(limit.enter('a')).not.toBeNull();
    expect(limit.enter('a')).not.toBeNull();
    expect(limit.enter('a')).toBeNull();
  });

  it('counts each key alone', () => {
    const limit = inFlightLimit(1);
    expect(limit.enter('a')).not.toBeNull();
    expect(limit.enter('b')).not.toBeNull();
  });

  it('gives a place back when one leaves', () => {
    const limit = inFlightLimit(1);
    const leave = limit.enter('a');
    leave?.();
    expect(limit.enter('a')).not.toBeNull();
  });

  it('gives a place back once, however often leave is called', () => {
    const limit = inFlightLimit(2);
    const leave = limit.enter('a');
    limit.enter('a');
    leave?.();
    leave?.();
    limit.enter('a');
    expect(limit.enter('a')).toBeNull();
  });

  it('forgets a key with nothing running, so the table cannot grow', () => {
    const limit = inFlightLimit(4);
    for (let n = 0; n < 1000; n += 1) limit.enter(String(n))?.();
    expect(limit.keys()).toBe(0);
  });

  it('agrees with a plain count over any order of arrivals and departures', () => {
    const steps = fc.array(
      fc.record({
        key: fc.constantFrom('a', 'b', 'c'),
        arrives: fc.boolean(),
      }),
      { maxLength: 200 },
    );
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4 }), steps, (cap, order) => {
        const limit = inFlightLimit(cap);
        const running = new Map<string, (() => void)[]>();
        for (const { key, arrives } of order) {
          const held = running.get(key) ?? [];
          running.set(key, held);
          if (arrives) {
            const leave = limit.enter(key);
            expect(leave === null).toBe(held.length >= cap);
            if (leave !== null) held.push(leave);
          } else {
            held.pop()?.();
          }
        }
        expect(limit.keys()).toBe([...running.values()].filter((held) => held.length > 0).length);
      }),
    );
  });
});
