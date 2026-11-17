import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { coalesce, newestFirst, type Queued } from '../src/index.ts';

const hex = fc.stringMatching(/^[0-9a-f]{8}$/);

// Enqueues as the store applies them: the first arrival of an id is kept, later ones dropped.
function enqueueAll(arrivals: readonly { id: string; at: number }[]): Queued[] {
  const kept = new Map<string, Queued>();
  for (const { id, at } of arrivals) {
    if (!kept.has(id)) kept.set(id, { id, receivedAt: new Date(at) });
  }
  return [...kept.values()];
}

describe('coalesce', () => {
  it('claims nothing from an empty queue', () => {
    expect(coalesce([])).toEqual({ claim: null, superseded: [] });
  });

  it('claims the latest arrival and breaks ties by the later id', () => {
    const at = new Date('2026-11-16T10:00:00Z');
    const a = { id: '0001', receivedAt: at };
    const b = { id: '0002', receivedAt: at };
    const old = { id: '0009', receivedAt: new Date(at.getTime() - 1) };
    expect(coalesce([a, old, b])).toEqual({ claim: b, superseded: [a, old] });
    expect(newestFirst(a, a)).toBe(0);
  });

  it('for any order and repetition of enqueues, leaves exactly one claim and nothing queued', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ id: hex, at: fc.integer({ min: 0, max: 50 }) }), { maxLength: 40 }),
        (arrivals) => {
          const queued = enqueueAll(arrivals);
          const shuffled = [...queued].reverse();
          const { claim, superseded } = coalesce(shuffled);
          // Everything is either claimed or superseded, so nothing stays queued for the binding.
          expect(superseded.length + (claim === null ? 0 : 1)).toBe(queued.length);
          if (claim === null) return;
          for (const other of superseded) expect(newestFirst(claim, other)).toBeLessThan(0);
          expect(coalesce(queued).claim).toEqual(claim);
        },
      ),
    );
  });
});
