import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sortRows } from '../src/react/table-sort.ts';

interface Row {
  id: string;
  key: string | number;
}

const rowsOf = (keys: fc.Arbitrary<string | number>) =>
  fc
    .array(keys, { maxLength: 40 })
    .map((list) => list.map((key, i): Row => ({ id: `r${String(i)}`, key })));

const numbers = rowsOf(fc.integer({ min: -1000, max: 1000 }));
const words = rowsOf(fc.stringMatching(/^[A-Za-z0-9 ]{0,8}$/));
const value = (row: Row) => row.key;
const ids = (rows: readonly Row[]) => rows.map((r) => r.id);
const position = (row: Row) => Number(row.id.slice(1));
// Each neighbouring pair, first to last.
const pairs = <T>(list: readonly T[]): [T, T][] =>
  list.flatMap((b, i): [T, T][] => {
    const a = list[i - 1];
    return i === 0 || a === undefined ? [] : [[a, b]];
  });

describe('sortRows', () => {
  for (const [kind, rows] of [
    ['numbers', numbers],
    ['words', words],
  ] as const) {
    it(`keeps every row once and leaves the input alone, for ${kind}`, () => {
      fc.assert(
        fc.property(rows, fc.constantFrom('ascending', 'descending'), (list, direction) => {
          const before = ids(list);
          const sorted = sortRows(list, value, direction);
          expect(ids(list)).toEqual(before);
          expect([...ids(sorted)].sort()).toEqual([...before].sort());
        }),
      );
    });

    it(`keeps equal rows in their given order in both directions, for ${kind}`, () => {
      fc.assert(
        fc.property(rows, fc.constantFrom('ascending', 'descending'), (list, direction) => {
          const sorted = sortRows(list, value, direction);
          for (const [a, b] of pairs(sorted)) {
            if (a.key === b.key) expect(position(a)).toBeLessThan(position(b));
          }
        }),
      );
    });
  }

  it('orders numbers by value, not as text', () => {
    fc.assert(
      fc.property(numbers, (list) => {
        const up = sortRows(list, value, 'ascending').map((r) => r.key as number);
        for (const [a, b] of pairs(up)) expect(a).toBeLessThanOrEqual(b);
        const down = sortRows(list, value, 'descending').map((r) => r.key as number);
        for (const [a, b] of pairs(down)) expect(a).toBeGreaterThanOrEqual(b);
      }),
    );
  });

  it('orders words as people read them: case aside and numbers inside by value', () => {
    const list: Row[] = ['Page 10', 'page 2', 'Page 1', 'apple', 'Banana'].map((key, i) => ({
      id: `r${String(i)}`,
      key,
    }));
    expect(sortRows(list, value, 'ascending').map((r) => r.key)).toEqual([
      'apple',
      'Banana',
      'Page 1',
      'page 2',
      'Page 10',
    ]);
    expect(sortRows(list, value, 'descending').map((r) => r.key)).toEqual([
      'Page 10',
      'page 2',
      'Page 1',
      'Banana',
      'apple',
    ]);
  });
});
