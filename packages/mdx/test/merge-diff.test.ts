import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { commonPairs, mergeSequences } from '../src/merge-diff.ts';

const lengthOfLongest = (a: readonly number[], b: readonly number[]) => {
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const row = table[i] as number[];
      const below = table[i + 1] as number[];
      row[j] =
        a[i] === b[j]
          ? (below[j + 1] as number) + 1
          : Math.max(below[j] as number, row[j + 1] as number);
    }
  }
  return table[0]?.[0] ?? 0;
};

const sequence = fc.array(fc.nat(5), { maxLength: 40 });

describe('commonPairs', () => {
  it('matches the longest common subsequence, in order, on equal items', () => {
    fc.assert(
      fc.property(sequence, sequence, (a, b) => {
        const pairs = commonPairs(a, b) as readonly (readonly [number, number])[];
        expect(pairs).toHaveLength(lengthOfLongest(a, b));
        for (const [index, [i, j]] of pairs.entries()) {
          expect(a[i]).toBe(b[j]);
          const previous = pairs[index - 1];
          if (previous === undefined) continue;
          expect(i).toBeGreaterThan(previous[0]);
          expect(j).toBeGreaterThan(previous[1]);
        }
      }),
      { numRuns: 2_000 },
    );
  });

  it('gives up past its budget, counted after the shared ends', () => {
    const middle = (from: number) => Array.from({ length: 10 }, (_, at) => from + at);
    expect(commonPairs(middle(100), middle(200), 99)).toBeUndefined();
    expect(commonPairs(middle(100), middle(200), 100)).toEqual([]);
    const wrapped = (from: number) => [1, 2, ...middle(from), 3];
    expect(commonPairs(wrapped(100), wrapped(200), 100)).toEqual([
      [0, 0],
      [1, 1],
      [12, 12],
    ]);
  });

  it('handles the empty cases', () => {
    expect(commonPairs([], [])).toEqual([]);
    expect(commonPairs([1], [])).toEqual([]);
    expect(commonPairs([], [1])).toEqual([]);
    expect(commonPairs([1], [2])).toEqual([]);
  });
});

const words = (text: string) => text.split('');
const merged = (base: string, ours: string, theirs: string) =>
  mergeSequences(words(base), words(ours), words(theirs))?.join('');

describe('mergeSequences', () => {
  it.each([
    ['nothing changed', 'abc', 'abc', 'abc', 'abc'],
    ['ours only', 'abc', 'aXc', 'abc', 'aXc'],
    ['theirs only', 'abc', 'abc', 'aYc', 'aYc'],
    ['both ends', 'abcde', 'Xbcde', 'abcdY', 'XbcdY'],
    ['one change on both', 'abc', 'aXc', 'aXc', 'aXc'],
    ['an insert at the start', 'abc', 'Xabc', 'abc', 'Xabc'],
    ['an insert at the end', 'abc', 'abc', 'abcY', 'abcY'],
    ['a delete', 'abcd', 'acd', 'abcY', 'acY'],
    ['empty base', '', 'X', '', 'X'],
  ])('merges %s', (_name, base, ours, theirs, expected) => {
    expect(merged(base, ours, theirs)).toBe(expected);
  });

  it.each([
    ['two changes to one item', 'abc', 'aXc', 'aYc'],
    ['two inserts at one spot', 'ab', 'aXb', 'aYb'],
    ['two changes on empty', '', 'X', 'Y'],
    ['a delete against a change', 'abc', 'ac', 'aYc'],
  ])('refuses %s', (_name, base, ours, theirs) => {
    expect(merged(base, ours, theirs)).toBeUndefined();
  });

  it('refuses inputs past its budget', () => {
    const long = (letter: string) => Array.from({ length: 3_000 }, (_, at) => `${letter}${at}`);
    expect(mergeSequences(long('a'), long('b'), long('c'))).toBeUndefined();
  });

  it('keeps every item of a side the other did not touch', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 2 }), { maxLength: 30 }), (base) => {
        const ours = [...base, 'NEW'];
        expect(mergeSequences(base, ours, base)).toEqual(ours);
        expect(mergeSequences(base, base, ours)).toEqual(ours);
      }),
    );
  });

  it('gives the same answer with the sides swapped, or none on both', () => {
    fc.assert(
      fc.property(sequence, sequence, sequence, (a, b, c) => {
        const [base, ours, theirs] = [a, b, c].map((list) => list.map(String)) as [
          string[],
          string[],
          string[],
        ];
        expect(mergeSequences(base, ours, theirs)).toEqual(mergeSequences(base, theirs, ours));
      }),
      { numRuns: 2_000 },
    );
  });
});
