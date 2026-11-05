import { describe, expect, it } from 'vitest';
import { meaningOf } from '../src/meaning.ts';
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
