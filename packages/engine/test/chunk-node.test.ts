import { describe, expect, it } from 'vitest';
import { chunkNode } from '../src/index.ts';
import { chunkTree, treeOf, visibleOf } from './support/tree.ts';

const options = { targetChars: 800, maxChars: 2000 };
const words = (chars: number) => 'word '.repeat(Math.ceil(chars / 5)).slice(0, chars);

describe('chunkNode boundaries', () => {
  it('gives nothing for an empty page', () => {
    expect(chunkTree(treeOf([]), options)).toEqual([]);
  });

  it('keeps small blocks together under one heading', () => {
    const root = treeOf([
      { raw: '# Guide', heading: { depth: 1, text: 'Guide' } },
      { raw: 'First.' },
      { raw: 'Second.' },
    ]);
    expect(chunkTree(root, options)).toEqual([
      {
        ord: 0,
        blockPath: '0',
        headingPath: ['Guide'],
        body: 'Guide\n\nFirst.\n\nSecond.',
      },
    ]);
  });

  it('starts a chunk at each heading and tracks the path through levels', () => {
    const root = treeOf([
      { raw: 'Intro.' },
      { raw: '# One', heading: { depth: 1, text: 'One' } },
      { raw: '## Two', heading: { depth: 2, text: 'Two' } },
      { raw: '#### Four', heading: { depth: 4, text: 'Four' } },
      { raw: '## Next', heading: { depth: 2, text: 'Next' } },
      { raw: '# Top', heading: { depth: 1, text: 'Top' } },
    ]);
    expect(
      chunkTree(root, options).map(({ blockPath, headingPath }) => [blockPath, headingPath]),
    ).toEqual([
      ['0', []],
      ['1', ['One']],
      ['2', ['One', 'Two']],
      ['3', ['One', 'Two', 'Four']],
      ['4', ['One', 'Next']],
      ['5', ['Top']],
    ]);
  });

  it('takes heading text from the unit the host marked as a heading', () => {
    const chunks = chunkNode(
      {
        state: 'ok',
        units: [
          { heading: { depth: 2, text: 'Use saveDraft' }, text: 'Use saveDraft' },
          { text: 'Body.' },
        ],
      },
      options,
    );
    expect(chunks).toEqual([
      { ord: 0, blockPath: '0', headingPath: ['Use saveDraft'], body: 'Use saveDraft\n\nBody.' },
    ]);
  });

  it('gives a page the render refused no chunks', () => {
    expect(chunkNode({ state: 'not_renderable' }, options)).toEqual([]);
  });

  it('skips a unit with no text but keeps its heading for what follows', () => {
    const chunks = chunkNode(
      {
        state: 'ok',
        units: [{ heading: { depth: 1, text: '' }, text: '' }, { text: '   ' }, { text: 'Body.' }],
      },
      options,
    );
    expect(chunks).toEqual([{ ord: 0, blockPath: '2', headingPath: [''], body: 'Body.' }]);
  });

  it('closes a chunk before it passes the target', () => {
    const root = treeOf([{ raw: words(500) }, { raw: words(290) }, { raw: words(100) }]);
    const chunks = chunkTree(root, options);
    expect(chunks.map(({ body }) => body.length)).toEqual([792, 100]);
    expect(chunks.map(({ blockPath }) => blockPath)).toEqual(['0', '2']);
  });

  it('splits a block over the target at line ends and numbers the parts', () => {
    const lines = Array.from({ length: 40 }, (_, at) => `line ${String(at)} ${words(50)}`);
    const raw = `\`\`\`\n${lines.join('\n')}\n\`\`\``;
    const chunks = chunkTree(treeOf([{ raw: 'Before.' }, { raw }]), options);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0]?.body).toBe('Before.');
    expect(chunks[1]?.blockPath).toBe('1.0');
    expect(chunks[2]?.blockPath).toBe('1.1');
    for (const chunk of chunks.slice(1, -1)) expect(chunk.body.endsWith('\n')).toBe(true);
  });

  it('holds the hard cap on a very long code block with one line', () => {
    const raw = `\`\`\`\n${'x'.repeat(10_074)}\n\`\`\``;
    const root = treeOf([{ raw }]);
    const chunks = chunkTree(root, options);
    expect(Math.max(...chunks.map(({ body }) => body.length))).toBeLessThanOrEqual(2000);
    expect(chunks.map(({ body }) => body).join('')).toBe(raw);
  });

  it('does not cut a pair of surrogates at the cap', () => {
    const root = treeOf([{ raw: `a${'\u{1F600}'.repeat(50)}` }]);
    const chunks = chunkTree(root, { targetChars: 10, maxChars: 10 });
    for (const { body } of chunks) expect(body.isWellFormed()).toBe(true);
    expect(chunks.map(({ body }) => body).join('')).toBe(visibleOf(root));
  });

  it('takes nothing from the gaps between blocks', () => {
    const root = treeOf([{ raw: 'One.' }, { raw: 'Two.', gap: '\n\n<!-- gap -->\n\n' }]);
    expect(chunkTree(root, options).map(({ body }) => body)).toEqual(['One.\n\nTwo.']);
  });

  it('starts a chunk on its text, never on blank lines', () => {
    const root = treeOf([{ raw: words(790) }, { raw: words(100) }]);
    expect(chunkTree(root, options)[1]?.body).toBe(words(100));
  });

  it('takes nothing from what follows the last block', () => {
    const chunks = chunkTree(treeOf([{ raw: 'One.' }], '\nleft over <!-- tail -->\n'), options);
    expect(chunks.map(({ body }) => body)).toEqual(['One.']);
  });

  it('gives a page that is only a tail no chunks', () => {
    expect(chunkTree(treeOf([], 'Tail.'), options)).toEqual([]);
  });

  it('caps heading text, so a long heading cannot grow every row beneath it', () => {
    const text = '\u{1F600}'.repeat(5000);
    const root = treeOf([{ raw: `# ${text}`, heading: { depth: 1, text } }, { raw: 'Body.' }]);
    for (const { headingPath } of chunkTree(root, options)) {
      expect(headingPath[0]?.length).toBeLessThanOrEqual(200);
      expect(headingPath[0]?.isWellFormed()).toBe(true);
    }
  });

  it('reads a block with no source, as the tree is what a reader gets', () => {
    const root = treeOf([{ raw: 'One.' }, { raw: 'Two.' }]);
    const [first, second] = root.children;
    const page = { ...root, children: [first, { ...second, source: undefined }] };
    expect(chunkTree(page as typeof root, options).map(({ body }) => body)).toEqual([
      'One.\n\nTwo.',
    ]);
  });

  it.each([
    [{ targetChars: 1, maxChars: 1 }],
    [{ targetChars: 0, maxChars: 10 }],
    [{ targetChars: 11, maxChars: 10 }],
  ])('refuses sizes it cannot honour: %j', (sizes) => {
    expect(() => chunkTree(treeOf([{ raw: 'One.' }]), sizes)).toThrow(RangeError);
  });

  it('keeps heading paths under a page budget on hostile deep headings', () => {
    const long = (depth: 1 | 2 | 3 | 4 | 5) => ({
      raw: '#',
      heading: { depth, text: '\u4e2d'.repeat(5000) },
    });
    const deep = Array.from({ length: 25_000 }, () => ({
      raw: '#',
      heading: { depth: 6, text: '\u4e2d' } as const,
    }));
    const root = treeOf([long(1), long(2), long(3), long(4), long(5), ...deep]);
    const chunks = chunkTree(root, options);
    const stored = chunks.reduce(
      (sum, { headingPath }) =>
        sum + headingPath.reduce((row, text) => row + Buffer.byteLength(text) + 1, 0),
      0,
    );
    expect(chunks.length).toBeGreaterThan(20_000);
    expect(stored).toBeLessThanOrEqual(1024 * 1024);
  });

  it('spends a section share to its last unit and not one past it', () => {
    // 262,144 over 7 headings is 37,449 and a fraction, so rounding up would give every section
    // one unit more. Each row of a section costs its heading plus one.
    const section = (cost: number, rows: number) => [
      { raw: '#', heading: { depth: 1, text: 'h'.repeat(cost - 1) } as const },
      ...Array.from({ length: rows - 1 }, () => ({ raw: 'body' })),
    ];
    const fills = section(73, 513);
    const passes = section(50, 749);
    const rest = Array.from({ length: 5 }, () => section(2, 1)).flat();
    expect(73 * fills.length).toBe(37_449);
    expect(50 * passes.length).toBe(37_450);

    const chunks = chunkTree(treeOf([...fills, ...passes, ...rest]), {
      targetChars: 4,
      maxChars: 2000,
    });
    const pathless = (from: number, to: number) =>
      chunks.slice(from, to).filter(({ headingPath }) => headingPath.length === 0).length;

    expect(pathless(0, fills.length)).toBe(0);
    expect(pathless(fills.length, fills.length + passes.length - 1)).toBe(0);
    expect(chunks[fills.length + passes.length - 1]?.headingPath).toEqual([]);
  });

  it('counts empty headings against the budget too', () => {
    // The most a tree may hold. Six elements on each row would pass the budget.
    const deep = Array.from({ length: 50_000 }, () => ({
      raw: '#',
      heading: { depth: 6, text: 'x' } as const,
    }));
    const empty = ([1, 2, 3, 4, 5] as const).map((depth) => ({
      raw: '#',
      heading: { depth, text: '' },
    }));
    const elements = chunkTree(treeOf([...empty, ...deep]), options).reduce(
      (sum, { headingPath }) => sum + headingPath.length,
      0,
    );
    expect(elements).toBeLessThanOrEqual(262_144);
  });

  it('leaves heading paths on a long honest page alone', () => {
    const section = (at: number) => [
      { raw: '#', heading: { depth: 2, text: `Section ${String(at)}` } as const },
      { raw: words(1500) },
    ];
    const root = treeOf(Array.from({ length: 500 }, (_, at) => section(at)).flat());
    const chunks = chunkTree(root, options);
    expect(chunks.at(-1)?.headingPath).toEqual(['Section 499']);
  });

  it('gives a section the same heading paths however much an earlier section spends', () => {
    const heading = (text: string) => ({ raw: '#', heading: { depth: 1, text } as const });
    const later = 's'.repeat(200);
    const page = (first: string) =>
      treeOf([heading('o'.repeat(200)), { raw: first }, heading(later), { raw: 'ab\ncd\n' }]);
    const second = (first: string) =>
      chunkTree(page(first), { targetChars: 3, maxChars: 3 }).filter(
        ({ blockPath }) => Number.parseInt(blockPath, 10) >= 2,
      );
    // Long enough that rows under the 200 character heading pass the whole page budget.
    const spends = second('ab\n'.repeat(2_000)).map(({ headingPath }) => headingPath);
    expect(spends).toEqual(second('ab\n').map(({ headingPath }) => headingPath));
    expect(spends[0]).toEqual([later]);
  });

  it('does not change its input', () => {
    const root = treeOf([{ raw: words(3000) }]);
    const before = JSON.stringify(root);
    chunkTree(root, options);
    expect(JSON.stringify(root)).toBe(before);
  });
});
