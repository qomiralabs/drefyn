import { describe, expect, it } from 'vitest';
import type { Chunk } from '../src/index.ts';
import { chunksBySection, treeOf } from './support/tree.ts';

const chunk = (ord: number, blockPath: string, body = 'x'): Chunk => ({
  ord,
  blockPath,
  headingPath: [],
  body,
});

const cpuMicros = (work: () => void): number => {
  const before = process.cpuUsage();
  work();
  const { user, system } = process.cpuUsage(before);
  return user + system;
};

// The cheapest of a few tries, as a collection or a cold function only ever adds time.
const fastest = (work: () => void): number =>
  Math.min(...Array.from({ length: 5 }, () => cpuMicros(work)));

describe('chunksBySection', () => {
  const root = treeOf([
    { raw: 'opening' },
    { raw: '# one', heading: { depth: 1, text: 'one' } },
    { raw: 'body' },
    { raw: '# two', heading: { depth: 1, text: 'two' } },
  ]);

  it('files each chunk under the section its block is in, in order and without ord', () => {
    const found = chunksBySection(root, [
      chunk(0, '0'),
      chunk(1, '1'),
      chunk(2, '2.0', 'first'),
      chunk(3, '2.1', 'second'),
      chunk(4, '3'),
    ]);
    expect([...found]).toEqual([
      [0, [{ blockPath: '0', headingPath: [], body: 'x' }]],
      [
        1,
        [
          { blockPath: '1', headingPath: [], body: 'x' },
          { blockPath: '2.0', headingPath: [], body: 'first' },
          { blockPath: '2.1', headingPath: [], body: 'second' },
        ],
      ],
      [2, [{ blockPath: '3', headingPath: [], body: 'x' }]],
    ]);
  });

  it('gives no sections for no chunks', () => {
    expect(chunksBySection(root, []).size).toBe(0);
  });

  // A short cap cuts one long block into tens of thousands of chunks, and this runs inside a
  // property test with a limit, so the cost has to stay in step with the chunk count.
  it('costs in step with the chunk count, however many land in one section', () => {
    const SMALL = 4_000;
    const TIMES_MORE = 8;
    const many = (count: number) =>
      Array.from({ length: count }, (_, at) => chunk(at, `2.${String(at)}`));
    const small = many(SMALL);
    const large = many(SMALL * TIMES_MORE);

    const smallCost = fastest(() => chunksBySection(root, small));
    const largeCost = fastest(() => chunksBySection(root, large));

    // The floor keeps a sample too short to time from inflating the ratio. A square would give
    // 64 times the cost, and in step gives 8.
    const ratio = largeCost / Math.max(smallCost, 1_000);
    expect(ratio).toBeLessThan(TIMES_MORE * 3);
  });
});
