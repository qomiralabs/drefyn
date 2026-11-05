import { describe, expect, it } from 'vitest';
import { rawOf } from '../src/index.ts';
import { keptItsBytes, meaningOf } from '../src/meaning.ts';
import type { MdxBlock } from '../src/index.ts';

const of = (...nodes: readonly unknown[]) => meaningOf(nodes as readonly MdxBlock[]);
const text = { type: 'text', value: 'a' };
const paragraph = (...children: readonly unknown[]) => ({ type: 'paragraph', children });
const jsx = (fields: object) => ({
  type: 'mdxJsxFlowElement',
  name: 'A',
  attributes: [],
  ...fields,
});
const attribute = (value: unknown, name = 'b') => ({ type: 'mdxJsxAttribute', name, value });

describe('what does not change the meaning of a page', () => {
  it.each([
    'break',
    'delete',
    'emphasis',
    'footnoteReference',
    'image',
    'imageReference',
    'inlineCode',
    'link',
    'linkReference',
    'strong',
    'text',
  ])('text settling as %s', (type) => {
    expect(of(paragraph({ type, value: 'b', children: [text] }))).toBe(of(paragraph(text)));
  });

  it('other text', () => {
    expect(of(paragraph({ type: 'text', value: 'a' }))).toBe(
      of(paragraph({ type: 'text', value: 'b' })),
    );
  });

  it('an empty paragraph, in any place', () => {
    expect(of(paragraph(), text, paragraph())).toBe(of(text));
    expect(of({ type: 'paragraph' })).not.toBe('');
  });

  it('line endings', () => {
    expect(of({ type: 'html', value: 'a\r\nb' })).toBe(of({ type: 'html', value: 'a\nb' }));
    expect(of({ type: 'code', value: 'a\r\nb', lang: 'c\r\nd', meta: 'e\rf' })).toBe(
      of({ type: 'code', value: 'a\nb', lang: 'c\nd', meta: 'e\nf' }),
    );
    expect(of(jsx({ attributes: [attribute('a\r\nb')] }))).toBe(
      of(jsx({ attributes: [attribute('a\nb')] })),
    );
    expect(of(jsx({ attributes: [attribute({ value: 'a\r\nb' })] }))).toBe(
      of(jsx({ attributes: [attribute({ value: 'a\nb' })] })),
    );
  });

  it('how a list or a table leaves things unsaid', () => {
    expect(of({ type: 'list', ordered: false, start: null, children: [] })).toBe(
      of({ type: 'list', children: [] }),
    );
    expect(of({ type: 'list', ordered: false, start: 5, children: [] })).toBe(
      of({ type: 'list', children: [] }),
    );
    expect(of({ type: 'list', ordered: true, start: null, children: [] })).toBe(
      of({ type: 'list', ordered: true, start: 1, children: [] }),
    );
    expect(of({ type: 'table', align: [null, null], children: [] })).toBe(
      of({ type: 'table', children: [] }),
    );
    expect(of({ type: 'table', align: ['left', null], children: [] })).toBe(
      of({ type: 'table', align: ['left'], children: [] }),
    );
  });

  it('the case of a definition name, which a parser folds', () => {
    expect(of({ type: 'definition', identifier: 'A', url: 'b' })).toBe(
      of({ type: 'definition', identifier: 'a', url: 'b' }),
    );
  });

  it('a code line of only whitespace', () => {
    expect(of({ type: 'code', value: 'a\n \t \nb' })).toBe(of({ type: 'code', value: 'a\n\nb' }));
  });

  it('a field that is absent, null or undefined', () => {
    expect(of({ type: 'code', value: 'a', lang: null, meta: undefined })).toBe(
      of({ type: 'code', value: 'a' }),
    );
    expect(of(jsx({ name: null }))).toBe(of(jsx({ name: undefined })));
    expect(of(jsx({ attributes: undefined }))).toBe(of(jsx({})));
    expect(of(jsx({ attributes: [attribute(null)] }))).toBe(
      of(jsx({ attributes: [attribute(undefined)] })),
    );
    expect(of(jsx({ attributes: [{ value: 'a' }] }))).toBe(
      of(jsx({ attributes: [{ name: null, value: 'a' }] })),
    );
  });
});

describe('what does', () => {
  const DIFFERENT: readonly (readonly [string, unknown, unknown])[] = [
    ['a block kind', paragraph(text), { type: 'blockquote', children: [text] }],
    ['a value', { type: 'html', value: 'a' }, { type: 'html', value: 'b' }],
    ['code', { type: 'code', value: 'a' }, { type: 'code', value: 'b' }],
    ['the end of a code line', { type: 'code', value: 'a ' }, { type: 'code', value: 'a' }],
    ['the start of a code line', { type: 'code', value: ' a' }, { type: 'code', value: 'a' }],
    ['a language', { type: 'code', value: 'a', lang: 'b' }, { type: 'code', value: 'a' }],
    ['a meta string', { type: 'code', value: 'a', meta: 'b' }, { type: 'code', value: 'a' }],
    [
      'a heading depth',
      { type: 'heading', depth: 1, children: [] },
      { type: 'heading', depth: 2, children: [] },
    ],
    [
      'a definition url',
      { type: 'definition', identifier: 'a', url: 'b' },
      { type: 'definition', identifier: 'a', url: 'c' },
    ],
    [
      'a definition name',
      { type: 'definition', identifier: 'a', url: 'b' },
      { type: 'definition', identifier: 'c', url: 'b' },
    ],
    [
      'a footnote name',
      { type: 'footnoteDefinition', identifier: 'a', children: [] },
      { type: 'footnoteDefinition', identifier: 'b', children: [] },
    ],
    ['a list kind', { type: 'list', ordered: true, children: [] }, { type: 'list', children: [] }],
    [
      'a list start',
      { type: 'list', ordered: true, start: 2, children: [] },
      { type: 'list', ordered: true, start: 3, children: [] },
    ],
    [
      'a column alignment',
      { type: 'table', align: ['left'], children: [] },
      { type: 'table', align: ['right'], children: [] },
    ],
    ['a jsx name', jsx({ name: 'A' }), jsx({ name: 'B' })],
    ['a fragment', jsx({ name: null }), jsx({ name: 'null' })],
    [
      'an inline jsx name',
      { type: 'mdxJsxTextElement', name: 'a', attributes: [] },
      { type: 'mdxJsxTextElement', name: 'b', attributes: [] },
    ],
    ['an attribute', jsx({ attributes: [attribute('c')] }), jsx({})],
    [
      'an attribute name',
      jsx({ attributes: [attribute('c', 'd')] }),
      jsx({ attributes: [attribute('c', 'e')] }),
    ],
    [
      'an attribute value',
      jsx({ attributes: [attribute('c')] }),
      jsx({ attributes: [attribute('d')] }),
    ],
    [
      'an expression attribute value',
      jsx({ attributes: [attribute({ value: 'c' })] }),
      jsx({ attributes: [attribute({ value: 'd' })] }),
    ],
    [
      'live text inside plain text',
      paragraph({ type: 'emphasis', children: [{ type: 'html', value: 'a' }] }),
      paragraph(text),
    ],
    [
      'a block inside a block',
      { type: 'blockquote', children: [paragraph(text)] },
      { type: 'blockquote', children: [] },
    ],
  ];

  it.each(DIFFERENT)('%s', (_name, one, two) => {
    expect(of(one)).not.toBe(of(two));
  });

  it('a block more or less, or their order', () => {
    const a = { type: 'html', value: 'a' };
    const b = { type: 'code', value: 'b' };
    expect(of(a, b)).not.toBe(of(b, a));
    expect(of(a, a)).not.toBe(of(a));
  });
});

describe('a block that claims its stored bytes', () => {
  const words = (value: string) => paragraph({ type: 'text', value });
  const stored = (node: unknown) =>
    ({ ...(node as object), source: { rawOf: rawOf(node as MdxBlock) } }) as unknown as MdxBlock;
  const kept = (block: unknown, again?: unknown) =>
    keptItsBytes(
      [block] as unknown as readonly MdxBlock[],
      (again === undefined ? [] : [again]) as unknown as readonly MdxBlock[],
    );
  const reference = (type: string, fields: object) => paragraph({ type, ...fields });
  const named = { children: [{ type: 'text', value: 'a' }] };

  it('holds when it comes back as the same tree', () => {
    expect(kept(stored(words('a')), words('a'))).toBe(true);
  });

  it('fails when it does not come back at all', () => {
    expect(kept(stored(words('a')))).toBe(false);
  });

  it('fails on added words, with no reference to explain them', () => {
    expect(kept(stored(words('a')), words('a and more'))).toBe(false);
  });

  it('does not ask this of a printed block', () => {
    expect(kept(words('a'), words('b'))).toBe(true);
    const moved = { ...words('a'), source: { rawOf: 'not this tree' } };
    expect(kept(moved, words('b'))).toBe(true);
  });

  it.each(['linkReference', 'imageReference', 'footnoteReference'])(
    'lets %s settle to the text that names it, either way',
    (type) => {
      const asReference = reference(type, named);
      expect(kept(stored(asReference), words('[a]'))).toBe(true);
      expect(kept(stored(words('[a]')), asReference)).toBe(true);
    },
  );

  it('finds a reference among other children', () => {
    const mixed = paragraph({ type: 'text', value: 'x ' }, { type: 'linkReference', ...named });
    expect(kept(stored(mixed), words('x [a]'))).toBe(true);
  });

  it('still wants every word the tree held, in order and whole', () => {
    expect(kept(stored(reference('linkReference', named)), words('b'))).toBe(false);
    const two = paragraph({ type: 'text', value: 'ab' }, { type: 'linkReference', ...named });
    expect(kept(stored(two), words('a b [a]'))).toBe(false);
  });

  it('reads alt text, and nothing that is not text', () => {
    const image = reference('imageReference', { alt: 'a' });
    expect(kept(stored(image), words('![a]'))).toBe(true);
    expect(kept(stored(image), words('b'))).toBe(false);
    const number = reference('linkReference', { value: 7, children: [] });
    expect(kept(stored(number), words('nothing'))).toBe(true);
  });

  it('skips what an editor left empty when it pairs the blocks', () => {
    expect(
      keptItsBytes(
        [paragraph(), stored(words('a'))] as readonly MdxBlock[],
        [words('a')] as unknown as readonly MdxBlock[],
      ),
    ).toBe(true);
  });
});

describe('fields a tree can leave out', () => {
  it('tells a value that is not text from one that is', () => {
    expect(of({ type: 'html', value: 0 })).not.toBe(of({ type: 'html', value: null }));
    expect(of({ type: 'code', value: 1 })).not.toBe(of({ type: 'code', value: 2 }));
  });

  it('gives a definition with no name no name, and folds only down', () => {
    expect(of({ type: 'definition', identifier: 1, url: 'a' })).toBe(
      of({ type: 'definition', url: 'a' }),
    );
    expect(of({ type: 'definition', identifier: 'ß', url: 'a' })).toBe(
      of({ type: 'definition', identifier: 'ß', url: 'a' }),
    );
    expect(of({ type: 'definition', identifier: 'ß', url: 'a' })).not.toBe(
      of({ type: 'definition', identifier: 'SS', url: 'a' }),
    );
  });

  it('keeps alignment by column', () => {
    expect(of({ type: 'table', align: ['left', null], children: [] })).not.toBe(
      of({ type: 'table', align: [null, 'left'], children: [] }),
    );
    expect(of({ type: 'table', align: ['left', null, null], children: [] })).toBe(
      of({ type: 'table', align: ['left'], children: [] }),
    );
    expect(of({ type: 'table', align: [null, null, 'left'], children: [] })).not.toBe(
      of({ type: 'table', align: [null, 'left'], children: [] }),
    );
  });
});
