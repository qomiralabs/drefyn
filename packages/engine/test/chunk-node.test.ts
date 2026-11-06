import { describe, expect, it } from 'vitest';
import { chunkNode } from '../src/index.ts';
import { treeOf, visibleOf } from './support/tree.ts';

const options = { targetChars: 800, maxChars: 2000 };
const words = (chars: number) => 'word '.repeat(Math.ceil(chars / 5)).slice(0, chars);

describe('chunkNode boundaries', () => {
  it('gives nothing for an empty page', () => {
    expect(chunkNode(treeOf([]), options)).toEqual([]);
  });

  it('keeps small blocks together under one heading', () => {
    const root = treeOf([
      { raw: '# Guide', heading: { depth: 1, text: 'Guide' } },
      { raw: 'First.' },
      { raw: 'Second.' },
    ]);
    expect(chunkNode(root, options)).toEqual([
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
      chunkNode(root, options).map(({ blockPath, headingPath }) => [blockPath, headingPath]),
    ).toEqual([
      ['0', []],
      ['1', ['One']],
      ['2', ['One', 'Two']],
      ['3', ['One', 'Two', 'Four']],
      ['4', ['One', 'Next']],
      ['5', ['Top']],
    ]);
  });

  it('reads heading text through inline marks and code', () => {
    const root = treeOf([{ raw: '# x', heading: { depth: 1, text: '' } }]);
    const heading = root.children[0];
    const inline = {
      ...heading,
      children: [
        { type: 'text', value: 'Use ' },
        { type: 'strong', children: [{ type: 'inlineCode', value: 'saveDraft' }] },
      ],
    };
    const page = { ...root, children: [inline] } as typeof root;
    expect(chunkNode(page, options)[0]?.headingPath).toEqual(['Use saveDraft']);
  });

  it('closes a chunk before it passes the target', () => {
    const root = treeOf([{ raw: words(500) }, { raw: words(290) }, { raw: words(100) }]);
    const chunks = chunkNode(root, options);
    expect(chunks.map(({ body }) => body.length)).toEqual([792, 100]);
    expect(chunks.map(({ blockPath }) => blockPath)).toEqual(['0', '2']);
  });

  it('splits a block over the target at line ends and numbers the parts', () => {
    const lines = Array.from({ length: 40 }, (_, at) => `line ${String(at)} ${words(50)}`);
    const raw = `\`\`\`\n${lines.join('\n')}\n\`\`\``;
    const chunks = chunkNode(treeOf([{ raw: 'Before.' }, { raw }]), options);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0]?.body).toBe('Before.');
    expect(chunks[1]?.blockPath).toBe('1.0');
    expect(chunks[2]?.blockPath).toBe('1.1');
    for (const chunk of chunks.slice(1, -1)) expect(chunk.body.endsWith('\n')).toBe(true);
  });

  it('holds the hard cap on a very long code block with one line', () => {
    const raw = `\`\`\`\n${'x'.repeat(10_074)}\n\`\`\``;
    const root = treeOf([{ raw }]);
    const chunks = chunkNode(root, options);
    expect(Math.max(...chunks.map(({ body }) => body.length))).toBeLessThanOrEqual(2000);
    expect(chunks.map(({ body }) => body).join('')).toBe(raw);
  });

  it('does not cut a pair of surrogates at the cap', () => {
    const root = treeOf([{ raw: `a${'\u{1F600}'.repeat(50)}` }]);
    const chunks = chunkNode(root, { targetChars: 10, maxChars: 10 });
    for (const { body } of chunks) expect(body.isWellFormed()).toBe(true);
    expect(chunks.map(({ body }) => body).join('')).toBe(visibleOf(root));
  });

  it('takes nothing from the gaps between blocks', () => {
    const root = treeOf([{ raw: 'One.' }, { raw: 'Two.', gap: '\n\n<!-- gap -->\n\n' }]);
    expect(chunkNode(root, options).map(({ body }) => body)).toEqual(['One.\n\nTwo.']);
  });

  it('starts a chunk on its text, never on blank lines', () => {
    const root = treeOf([{ raw: words(790) }, { raw: words(100) }]);
    expect(chunkNode(root, options)[1]?.body).toBe(words(100));
  });

  it('takes nothing from what follows the last block', () => {
    const chunks = chunkNode(treeOf([{ raw: 'One.' }], '\nleft over <!-- tail -->\n'), options);
    expect(chunks.map(({ body }) => body)).toEqual(['One.']);
  });

  it('gives a page that is only a tail no chunks', () => {
    expect(chunkNode(treeOf([], 'Tail.'), options)).toEqual([]);
  });

  it('caps heading text, so a long heading cannot grow every row beneath it', () => {
    const text = '\u{1F600}'.repeat(5000);
    const root = treeOf([{ raw: `# ${text}`, heading: { depth: 1, text } }, { raw: 'Body.' }]);
    for (const { headingPath } of chunkNode(root, options)) {
      expect(headingPath[0]?.length).toBeLessThanOrEqual(200);
      expect(headingPath[0]?.isWellFormed()).toBe(true);
    }
  });

  it('reads a block with no source, as the tree is what a reader gets', () => {
    const root = treeOf([{ raw: 'One.' }, { raw: 'Two.' }]);
    const [first, second] = root.children;
    const page = { ...root, children: [first, { ...second, source: undefined }] };
    expect(chunkNode(page as typeof root, options).map(({ body }) => body)).toEqual([
      'One.\n\nTwo.',
    ]);
  });

  it.each([
    [{ targetChars: 1, maxChars: 1 }],
    [{ targetChars: 0, maxChars: 10 }],
    [{ targetChars: 11, maxChars: 10 }],
  ])('refuses sizes it cannot honour: %j', (sizes) => {
    expect(() => chunkNode(treeOf([{ raw: 'One.' }]), sizes)).toThrow(RangeError);
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
    const chunks = chunkNode(root, options);
    const stored = chunks.reduce(
      (sum, { headingPath }) =>
        sum + headingPath.reduce((row, text) => row + Buffer.byteLength(text) + 1, 0),
      0,
    );
    expect(chunks.length).toBeGreaterThan(20_000);
    expect(stored).toBeLessThanOrEqual(1024 * 1024);
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
    const elements = chunkNode(treeOf([...empty, ...deep]), options).reduce(
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
    const chunks = chunkNode(root, options);
    expect(chunks.at(-1)?.headingPath).toEqual(['Section 499']);
  });

  it('does not change its input', () => {
    const root = treeOf([{ raw: words(3000) }]);
    const before = JSON.stringify(root);
    chunkNode(root, options);
    expect(JSON.stringify(root)).toBe(before);
  });
});
