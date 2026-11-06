import { describe, expect, it } from 'vitest';
import { chunkNode } from '../src/index.ts';
import { sourceOf, treeOf } from './support/tree.ts';

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
        body: '# Guide\n\nFirst.\n\nSecond.',
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
    expect(chunks.map(({ body }) => body.length)).toEqual([792, 102]);
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
    expect(chunks.map(({ body }) => body).join('')).toBe(sourceOf(root));
  });

  it('counts the gap before a block toward its size', () => {
    const gap = '\n'.repeat(5000);
    const root = treeOf([{ raw: 'One.' }, { raw: 'Two.', gap }]);
    const chunks = chunkNode(root, options);
    expect(Math.max(...chunks.map(({ body }) => body.length))).toBeLessThanOrEqual(2000);
    expect(chunks.map(({ body }) => body).join('')).toBe(sourceOf(root));
  });

  it('keeps a short tail on the last chunk rather than a chunk of its own', () => {
    const chunks = chunkNode(treeOf([{ raw: 'One.' }], '\n'), options);
    expect(chunks.map(({ body }) => body)).toEqual(['One.\n']);
  });

  it('gives a long tail chunks of its own', () => {
    const tail = `${words(1500)}\n`.repeat(3);
    const root = treeOf([{ raw: 'One.' }], tail);
    const chunks = chunkNode(root, options);
    expect(chunks.map(({ body }) => body).join('')).toBe(sourceOf(root));
    expect(chunks.length).toBeGreaterThan(2);
  });

  it('chunks a page that is only a tail', () => {
    expect(chunkNode(treeOf([], 'Tail.'), options).map(({ body }) => body)).toEqual(['Tail.']);
  });

  it('caps heading text, so a long heading cannot grow every row beneath it', () => {
    const text = '\u{1F600}'.repeat(5000);
    const root = treeOf([{ raw: `# ${text}`, heading: { depth: 1, text } }, { raw: 'Body.' }]);
    for (const { headingPath } of chunkNode(root, options)) {
      expect(headingPath[0]?.length).toBeLessThanOrEqual(200);
      expect(headingPath[0]?.isWellFormed()).toBe(true);
    }
  });

  it('skips a block that has no source yet, as printing would give it one', () => {
    const root = treeOf([{ raw: 'One.' }, { raw: 'Two.' }]);
    const { source: _dropped, ...fresh } = root.children[1] ?? {};
    const page = { ...root, children: [root.children[0], fresh] } as typeof root;
    expect(chunkNode(page, options).map(({ body }) => body)).toEqual(['One.']);
  });

  it.each([
    [{ targetChars: 1, maxChars: 1 }],
    [{ targetChars: 0, maxChars: 10 }],
    [{ targetChars: 11, maxChars: 10 }],
  ])('refuses sizes it cannot honour: %j', (sizes) => {
    expect(() => chunkNode(treeOf([{ raw: 'One.' }]), sizes)).toThrow(RangeError);
  });

  it('does not change its input', () => {
    const root = treeOf([{ raw: words(3000) }]);
    const before = JSON.stringify(root);
    chunkNode(root, options);
    expect(JSON.stringify(root)).toBe(before);
  });
});
