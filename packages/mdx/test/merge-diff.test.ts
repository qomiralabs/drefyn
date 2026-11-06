import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { commonPairs, mergeSequences } from '../src/merge-diff.ts';

const lengthOfLongest = (a: readonly number[], b: readonly number[]) => {
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  const read = (i: number, j: number) => table[i]?.[j] ?? 0;
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const best =
        a[i] === b[j] ? read(i + 1, j + 1) + 1 : Math.max(read(i + 1, j), read(i, j + 1));
      table[i]?.splice(j, 1, best);
    }
  }
  return read(0, 0);
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

  it('gives up past its budget, counted on what the two lists share', () => {
    const items = Array.from({ length: 10 }, (_, at) => 100 + at);
    const reversed = [...items].reverse();
    expect(commonPairs(items, reversed, 99)).toBeUndefined();
    expect(commonPairs(items, reversed, 100)).toHaveLength(1);
    const wrapped = (middle: readonly number[]) => [1, 2, ...middle, 3];
    expect(commonPairs(wrapped(items), wrapped(reversed), 100)).toHaveLength(4);
    expect(commonPairs(wrapped(items), wrapped(reversed), 99)).toBeUndefined();
  });

  it('spends nothing on items only one list holds', () => {
    const long = (from: number) => Array.from({ length: 1_000 }, (_, at) => from + at);
    expect(commonPairs(long(0), long(10_000), 0)).toEqual([]);
    expect(commonPairs([...long(0), 7], [...long(10_000), 7], 0)).toEqual([[1_000, 1_000]]);
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
    const long = Array.from({ length: 3_000 }, (_, at) => `${at}`);
    expect(mergeSequences(long, [...long].reverse(), long)).toBeUndefined();
    expect(mergeSequences(long, long, [...long].reverse())).toBeUndefined();
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
