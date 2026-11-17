import { describe, expect, it } from 'vitest';
import type { Entry, MergeNode } from '../src/merge-align.ts';
import { isEmptied, mergedEntry, mergeNode, settle } from '../src/merge-nodes.ts';
import type { MergeContext } from '../src/merge-nodes.ts';
import { mergeChildren } from '../src/merge-sequence.ts';
import type { MdxRoot } from '../src/index.ts';
import { parsed, policy } from './helpers.ts';

const context = (overrides: Partial<MergeContext> = {}): MergeContext => {
  const built: MergeContext = {
    dialect: 'md',
    policy: policy(),
    definitions: () => ({ text: '', count: 0 }),
    children: (a, b, c) => mergeChildren(a, b, c, built),
    ...overrides,
  };
  return built;
};

const nodeOf = (root: MdxRoot) => root.children[0] as unknown as MergeNode;
const first = (source: string) => nodeOf(parsed(source, 'md'));
const merge = (base: string, ours: string, theirs: string) =>
  mergeNode(first(base), first(ours), first(theirs), context());

const text = (value: string) => ({ type: 'text', value });
const paragraph = (value: string): MergeNode => ({ type: 'paragraph', children: [text(value)] });

describe('mergeNode', () => {
  it('refuses when any side changed the kind', () => {
    const para = paragraph('words');
    const head: MergeNode = { type: 'heading', depth: 1, children: [text('words')] };
    expect(mergeNode(para, head, para, context())).toBeUndefined();
    expect(mergeNode(para, para, head, context())).toBeUndefined();
    expect(mergeNode(para, head, head, context())).toBeUndefined();
  });

  it('refuses a list that became something else, on either side', () => {
    const list = first('- one\n- two\n');
    const para = paragraph('one two');
    expect(mergeNode(list, para, list, context())).toBeUndefined();
    expect(mergeNode(list, list, para, context())).toBeUndefined();
  });

  it('has no merge for kinds it cannot look inside', () => {
    const code = (value: string): MergeNode => ({ type: 'code', value });
    expect(mergeNode(code('a b'), code('a c'), code('d b'), context())).toBeUndefined();
  });

  it('merges a table cell word by word and keeps it a cell', () => {
    const cell = (value: string): MergeNode => ({ type: 'tableCell', children: [text(value)] });
    const merged = mergeNode(
      cell('one two three'),
      cell('ONE two three'),
      cell('one two THREE'),
      context(),
    );
    expect(merged).toEqual(cell('ONE two THREE'));
  });

  it('refuses a table cell edited on one word from both sides', () => {
    const cell = (value: string): MergeNode => ({ type: 'tableCell', children: [text(value)] });
    expect(mergeNode(cell('one'), cell('two'), cell('three'), context())).toBeUndefined();
  });

  it('merges inside a cell in one row, through the row', () => {
    const row = (one: string, two: string) => first(`| h | i |\n| - | - |\n| ${one} | ${two} |\n`);
    const merged = mergeNode(row('a b c', 'd'), row('A b c', 'd'), row('a b C', 'D'), context());
    expect(JSON.stringify(merged)).toContain('A b C');
    expect(JSON.stringify(merged)).toContain('"D"');
  });

  it.each([
    ['one side', '# Words here\n', '## Words here\n', '# Other here\n', '## Other here'],
    ['the other side', '# Words here\n', '# Other here\n', '## Words here\n', '## Other here'],
  ])('takes a heading depth from %s', (_name, base, ours, theirs, expected) => {
    const merged = merge(base, ours, theirs);
    expect(merged).toMatchObject({ type: 'heading', depth: 2 });
    expect(JSON.stringify(merged)).toContain(expected.slice(3));
  });

  it('refuses a heading set to two depths, whatever its words do', () => {
    expect(merge('# a\n', '## a\n', '### a\n')).toBeUndefined();
  });

  const list = (fields: Readonly<Record<string, unknown>>): MergeNode => ({
    type: 'list',
    ordered: false,
    start: null,
    spread: false,
    children: [{ type: 'listItem', spread: false, checked: null, children: [paragraph('one')] }],
    ...fields,
  });

  it.each([
    ['ordered', true, 'x'],
    ['start', 3, 4],
    ['spread', true, 'x'],
  ])('merges the %s of a list', (field, value, other) => {
    const base = list({});
    const ours = list({ [field]: value });
    const theirs = list({ [field]: other });
    expect(mergeNode(base, ours, base, context())).toMatchObject({ [field]: value });
    expect(mergeNode(base, base, ours, context())).toMatchObject({ [field]: value });
    expect(mergeNode(base, ours, ours, context())).toMatchObject({ [field]: value });
    expect(mergeNode(base, ours, theirs, context())).toBeUndefined();
  });

  const item = (fields: Readonly<Record<string, unknown>>): MergeNode => ({
    type: 'listItem',
    spread: false,
    checked: null,
    children: [paragraph('one')],
    ...fields,
  });

  it.each([
    ['checked', true, false],
    ['spread', true, 'x'],
  ])('merges the %s of a list item', (field, value, other) => {
    const base = item({});
    expect(mergeNode(base, item({ [field]: value }), base, context())).toMatchObject({
      [field]: value,
    });
    expect(
      mergeNode(base, item({ [field]: value }), item({ [field]: other }), context()),
    ).toBeUndefined();
  });

  const table = (align: unknown, ...rows: readonly (readonly string[])[]): MergeNode => ({
    type: 'table',
    align,
    children: rows.map((cells) => ({
      type: 'tableRow',
      children: cells.map((cell) => ({ type: 'tableCell', children: [text(cell)] })),
    })),
  });

  it('refuses a table a merge left with rows of different widths', () => {
    const base = table(null, ['a', 'b'], ['c', 'd']);
    const ours = table(null, ['a', 'b', 'x'], ['c', 'd', 'y']);
    const theirs = table(null, ['a', 'b'], ['c', 'd'], ['e', 'f']);
    expect(mergeNode(base, ours, theirs, context())).toBeUndefined();
  });

  it('takes alignment from whichever side set it', () => {
    const rows: readonly (readonly string[])[] = [
      ['a', 'b'],
      ['c', 'd'],
    ];
    const base = table([null, null], ...rows);
    const set = table(['left', null], ...rows);
    expect(mergeNode(base, set, base, context())).toMatchObject({ align: ['left', null] });
    expect(mergeNode(base, base, set, context())).toMatchObject({ align: ['left', null] });
  });

  it('merges a table with every row gone', () => {
    const base = table(null, ['a']);
    const empty = table(null);
    expect(mergeNode(base, empty, empty, context())).toMatchObject({ children: [] });
  });

  it('merges inside a quote', () => {
    const merged = merge('> a\n>\n> b\n', '> A\n>\n> b\n', '> a\n>\n> B\n');
    expect(JSON.stringify(merged)).toContain('"A"');
    expect(JSON.stringify(merged)).toContain('"B"');
  });

  it('refuses when a child cannot be merged', () => {
    expect(merge('> a b\n', '> c b\n', '> d b\n')).toBeUndefined();
  });

  it('refuses a paragraph any side cannot print', () => {
    const alien: MergeNode = { type: 'paragraph', children: [{ type: 'alien' }] };
    const good = paragraph('words');
    expect(mergeNode(alien, good, paragraph('more'), context())).toBeUndefined();
    expect(mergeNode(good, alien, paragraph('more'), context())).toBeUndefined();
    expect(mergeNode(good, paragraph('more'), alien, context())).toBeUndefined();
  });

  it('refuses when the page has no sound definitions', () => {
    const broken = context({ definitions: () => undefined });
    const merged = mergeNode(paragraph('a b c'), paragraph('A b c'), paragraph('a b C'), broken);
    expect(merged).toBeUndefined();
  });

  it('refuses a merge that stops being the kind it was', () => {
    const html = (value: string): MergeNode => ({
      type: 'paragraph',
      children: [{ type: 'html', value }],
    });
    const merged = mergeNode(html('a b c'), html('# b c'), html('a b C'), context());
    expect(merged).toBeUndefined();
  });

  it('refuses a merge the parser refuses', () => {
    const mdx = context({ dialect: 'mdx' });
    const ofText = (source: string) => nodeOf(parsed(source, 'mdx'));
    const merged = mergeNode(
      ofText('one two three\n'),
      ofText('<b>one two</b> three\n'),
      ofText('one <i>two three</i>\n'),
      mdx,
    );
    expect(merged).toBeUndefined();
  });

  it('merges text with no spaces, one CJK character at a time', () => {
    const merged = merge(
      '今日はいい天気カタカナです\n',
      '明日はいい天気カタカナです\n',
      '今日はいい天気カタカナだ\n',
    );
    expect(JSON.stringify(merged)).toContain('明日はいい天気カタカナだ');
    const kana = merge('あいうえお\n', 'かいうえお\n', 'あいうえこ\n');
    expect(JSON.stringify(kana)).toContain('かいうえこ');
    const katakana = merge('アイウエオ\n', 'カイウエオ\n', 'アイウエコ\n');
    expect(JSON.stringify(katakana)).toContain('カイウエコ');
  });

  it('treats a run of letters and digits as one word', () => {
    expect(merge('abc def\n', 'abX def\n', 'abY def\n')).toBeUndefined();
    expect(merge('a1_b def\n', 'a1_c def\n', 'a1_d def\n')).toBeUndefined();
  });

  it('keeps punctuation apart from words', () => {
    const merged = merge('one,two\n', 'ONE,two\n', 'one,TWO\n');
    expect(JSON.stringify(merged)).toContain('ONE,TWO');
  });
});

describe('settle', () => {
  it('takes the shape the print parses to', () => {
    const node = {
      type: 'paragraph',
      children: [text('a'), text('b')],
    } satisfies MergeNode;
    expect(settle(node, context())).toEqual({ type: 'paragraph', children: [text('ab')] });
  });

  it('refuses what prints as two blocks', () => {
    const two: MergeNode = {
      type: 'paragraph',
      children: [{ type: 'html', value: 'a\n\n# b' }],
    };
    expect(settle(two, context())).toBeUndefined();
  });

  it('refuses what it cannot print', () => {
    expect(settle({ type: 'alien' }, context())).toBeUndefined();
  });

  it('counts the definitions beside the block', () => {
    const definitions = () => ({ text: '[a]: https://a.example', count: 1 });
    const reference = first('[a]\n\n[a]: https://a.example\n');
    expect(settle(reference, context({ definitions }))?.type).toBe('paragraph');
    expect(settle(paragraph('fine'), context({ definitions }))?.type).toBe('paragraph');
    const eaten = context({ definitions: () => ({ text: '', count: 1 }) });
    expect(settle(paragraph('fine'), eaten)).toBeUndefined();
  });

  it('holds no source of its own', () => {
    expect(settle(paragraph('fine'), context())).not.toHaveProperty('source');
  });

  it.each(['list', 'table', 'blockquote'])('leaves an emptied %s alone', (type) => {
    const empty = { type, children: [] };
    expect(isEmptied(empty)).toBe(true);
    expect(settle(empty, context())).toBe(empty);
  });

  it('does not call a block with something left, or a paragraph, emptied', () => {
    expect(isEmptied({ type: 'list', children: [paragraph('a')] })).toBe(false);
    expect(isEmptied({ type: 'paragraph', children: [] })).toBe(false);
    expect(isEmptied({ type: 'list' })).toBe(true);
  });
});

describe('mergedEntry', () => {
  const source = { raw: 'a', gapBefore: '\n', rawOf: 'x', sourceOf: 'y' };

  it('takes the source of the base block', () => {
    const base: Entry = { node: { type: 'text', source }, hash: 'h', previous: 'p' };
    expect(mergedEntry(base, { type: 'paragraph' }, 'new')).toEqual({
      node: { type: 'paragraph', source },
      hash: 'new',
      previous: 'p',
    });
  });

  it('adds no source for a block that has none', () => {
    const base: Entry = { node: { type: 'text' }, hash: 'h', previous: null };
    expect(mergedEntry(base, { type: 'paragraph' }, 'new').node).toEqual({ type: 'paragraph' });
  });
});
