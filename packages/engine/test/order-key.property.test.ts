import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isOrderKey, MAX_ORDER_KEY_CHARS, orderKeyBetween } from '../src/order-key.ts';

const placed = (low: string | null, high: string | null): string => {
  const key = orderKeyBetween(low, high);
  if (key === null) throw new Error(`no key between ${String(low)} and ${String(high)}`);
  return key;
};

// Where each insert lands in a list of what came before, as a fraction of its length.
const positions = fc.array(fc.nat({ max: 1000 }), { minLength: 1, maxLength: 200 });

function insertAll(spots: readonly number[]): readonly string[] {
  const keys: string[] = [];
  for (const spot of spots) {
    const at = Math.floor((spot * keys.length) / 1000);
    keys.splice(at, 0, placed(keys[at - 1] ?? null, keys[at] ?? null));
  }
  return keys;
}

const isSorted = (keys: readonly string[]) =>
  keys.every((key, index) => index === 0 || (keys[index - 1] ?? '') < key);

// Compares bytes, as Postgres does under the C collation.
const byteSorted = (keys: readonly string[]) =>
  [...keys].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));

describe('orderKeyBetween', () => {
  it('starts where createNode has always started', () => {
    expect(orderKeyBetween(null, null)).toBe('a0');
  });

  it('keeps any insert order sorted, with every key distinct and valid', () => {
    fc.assert(
      fc.property(positions, (spots) => {
        const keys = insertAll(spots);
        expect(isSorted(keys)).toBe(true);
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys.every(isOrderKey)).toBe(true);
        expect(byteSorted(keys)).toEqual(keys);
      }),
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(positions, (spots) => {
        expect(insertAll(spots)).toEqual(insertAll(spots));
      }),
    );
  });

  it('always lands strictly between two valid keys', () => {
    fc.assert(
      fc.property(positions, fc.nat(), fc.nat(), (spots, first, second) => {
        const keys = insertAll(spots);
        const low = keys[first % keys.length] ?? null;
        const high = keys[second % keys.length] ?? null;
        if (low === null || high === null || low === high) return;
        const [a, b] = low < high ? [low, high] : [high, low];
        const key = placed(a, b);
        expect(a < key && key < b).toBe(true);
      }),
    );
  });

  it.each([
    ['right after the same node', (low: string, high: string) => [low, placed(low, high)]],
    ['right before the same node', (low: string, high: string) => [placed(low, high), high]],
  ])('stays sorted over a long run %s', (_name, step) => {
    let [low, high] = ['a0', 'a1'];
    const seen = new Set<string>();
    const RUN = 5000;
    for (let turn = 0; turn < RUN; turn += 1) {
      const narrowed = step(low, high);
      [low = '', high = ''] = narrowed;
      expect(low < high).toBe(true);
      seen.add(low).add(high);
    }
    expect(seen.size).toBe(RUN + 1);
    expect(Math.max(low.length, high.length)).toBeLessThan(MAX_ORDER_KEY_CHARS);
  });

  it('keeps a key short over a long run at either end, the common case', () => {
    let tail = 'a0';
    let head = 'a0';
    let outOfOrder = 0;
    // One expect at the end: 200,000 of them take longer than the keys do.
    for (let turn = 0; turn < 100_000; turn += 1) {
      const nextTail = placed(tail, null);
      const nextHead = placed(null, head);
      if (!(tail < nextTail && nextHead < head)) outOfOrder += 1;
      tail = nextTail;
      head = nextHead;
    }
    expect(outOfOrder).toBe(0);
    expect(Math.max(tail.length, head.length)).toBeLessThanOrEqual(5);
  });

  it('carries across a change of integer length, up and down', () => {
    expect(placed('az', null)).toBe('b00');
    expect(placed('bzz', null)).toBe('c000');
    expect(placed('Yzz', null)).toBe('Z0');
    expect(placed('Zz', null)).toBe('a0');
    expect(placed(null, 'a0')).toBe('Zz');
    expect(placed(null, 'b00')).toBe('az');
    expect(placed(null, 'Z0')).toBe('Yzz');
  });

  it('uses the next integer when it fits, and a fraction when it does not', () => {
    expect(placed('a0', 'a2')).toBe('a1');
    expect(placed('a0', 'a1')).toBe('a0V');
    expect(placed('a0', 'a1V')).toBe('a1');
    expect(placed(null, 'a1V')).toBe('a1');
  });

  it('still has room past the ends of the integer range', () => {
    const smallest = `A${'0'.repeat(25)}1`;
    const largest = `z${'z'.repeat(26)}`;
    expect(isOrderKey(smallest)).toBe(true);
    expect(placed(largest, null) > largest).toBe(true);
    const lower = placed(null, `A${'0'.repeat(26)}1`);
    expect(lower < `A${'0'.repeat(26)}1`).toBe(true);
    expect(isOrderKey(lower)).toBe(true);
  });

  it('has nothing to give for a tie or a reversed pair', () => {
    expect(orderKeyBetween('a0', 'a0')).toBeNull();
    expect(orderKeyBetween('a2', 'a1')).toBeNull();
  });

  it.each(['', 'a', '0', '!a0', 'a0-', 'a00', 'a00V0', `A${'0'.repeat(26)}`, 'é0'])(
    'refuses %j as a neighbour',
    (bad) => {
      expect(isOrderKey(bad)).toBe(false);
      expect(orderKeyBetween(bad, null)).toBeNull();
      expect(orderKeyBetween(null, bad)).toBeNull();
    },
  );
});
