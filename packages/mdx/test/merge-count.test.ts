import { describe, expect, it } from 'vitest';
import { tokenCounts, unexplainedTokens } from '../src/merge-count.ts';
import type { MdxRoot } from '../src/index.ts';
import { parsed } from './helpers.ts';

const tree = (...children: readonly unknown[]) =>
  ({ ...parsed('', 'md'), children }) as unknown as MdxRoot;
const text = (value: string) => ({ type: 'paragraph', children: [{ type: 'text', value }] });
const count = (root: MdxRoot, token: string) => tokenCounts(root).get(token) ?? 0;

// b, o, t and m for one word: its count in base, ours, theirs and the merged page.
const judge = (b: number, o: number, t: number, m: number) => {
  const page = (times: number) => tree(text(Array.from({ length: times }, () => 'w').join(' ')));
  return unexplainedTokens(page(b), page(o), page(t), page(m));
};

describe('the bounds on one token', () => {
  it.each([
    ['nobody touched it', 1, 1, 1, 1],
    ['one side removed it', 1, 0, 1, 0],
    ['both removed it', 1, 0, 0, 0],
    ['one side added one', 1, 2, 1, 2],
    ['both added the same one', 1, 2, 2, 2],
    ['both added one of their own', 1, 2, 2, 3],
    ['the same edit on both sides of a common word', 3, 2, 2, 2],
    ['two sides cut one each from a common word', 3, 2, 2, 1],
    ['nobody has it', 0, 0, 0, 0],
  ])('explains %s', (_name, b, o, t, m) => {
    expect(judge(b, o, t, m)).toBe(0);
  });

  it.each([
    ['a delete undone', 1, 0, 1, 1],
    ['a delete undone from theirs', 1, 1, 0, 1],
    ['a delete both made, undone', 1, 0, 0, 1],
    ['a duplicate', 1, 1, 1, 2],
    ['a new word doubled', 0, 1, 0, 2],
    ['a word both kept, lost', 1, 1, 1, 0],
    ['an insert lost', 0, 1, 0, 0],
    ['an insert from theirs lost', 0, 0, 1, 0],
    ['a word from nowhere', 0, 0, 0, 1],
    ['a shared insert lost', 0, 1, 1, 0],
  ])('catches %s', (_name, b, o, t, m) => {
    expect(judge(b, o, t, m)).toBe(1);
  });

  it('counts each token that breaks once, by token', () => {
    const page = (...words: readonly string[]) => tree(text(words.join(' ')));
    expect(unexplainedTokens(page('a', 'b'), page('b'), page('a'), page('a', 'b', 'c'))).toBe(3);
    expect(unexplainedTokens(page('a', 'b'), page('a'), page('a', 'b'), page('a'))).toBe(0);
  });
});

describe('the tokens of a tree', () => {
  it('splits on any white space, and keeps punctuation and case', () => {
    const counts = tokenCounts(tree(text('Key, key\n  key\t$$$ 🙂 !!!')));
    expect([...counts]).toEqual(
      expect.arrayContaining([
        ['Key,', 1],
        ['key', 2],
        ['$$$', 1],
        ['🙂', 1],
        ['!!!', 1],
      ]),
    );
  });

  it('holds no empty token', () => {
    expect(tokenCounts(tree(text('  a  '))).has('')).toBe(false);
  });

  it.each([
    ['text', { type: 'text', value: 'found' }],
    ['code', { type: 'code', value: 'found' }],
    ['a language', { type: 'code', value: '', lang: 'found' }],
    ['code meta', { type: 'code', value: '', meta: 'found' }],
    ['frontmatter', { type: 'yaml', value: 'found' }],
    ['ESM', { type: 'mdxjsEsm', value: 'found' }],
    ['an expression', { type: 'mdxFlowExpression', value: 'found' }],
    ['html', { type: 'html', value: 'found' }],
    ['image text', { type: 'image', alt: 'found' }],
    ['an image address', { type: 'image', url: 'found' }],
    ['a title', { type: 'image', title: 'found' }],
    ['a link address', { type: 'link', url: 'found', children: [] }],
    ['a definition', { type: 'definition', url: 'found' }],
    ['a component name', { type: 'mdxJsxFlowElement', name: 'found', children: [] }],
  ])('reads %s', (_name, node) => {
    expect(count(tree(node), 'found')).toBe(1);
  });

  it('reads attribute names and both kinds of attribute value', () => {
    const attributes = [
      { type: 'mdxJsxAttribute', name: 'one', value: 'two' },
      {
        type: 'mdxJsxAttribute',
        name: 'three',
        value: { type: 'mdxJsxAttributeValueExpression', value: 'four' },
      },
    ];
    const root = tree({ type: 'mdxJsxFlowElement', name: 'A', attributes, children: [] });
    for (const token of ['one', 'two', 'three', 'four']) expect(count(root, token)).toBe(1);
  });

  it('reads at any depth', () => {
    const image = { type: 'image', alt: 'deep' };
    const root = tree({
      type: 'blockquote',
      children: [{ type: 'list', children: [{ type: 'paragraph', children: [image] }] }],
    });
    expect(count(root, 'deep')).toBe(1);
  });

  it('skips what is not content', () => {
    const source = { raw: 'hidden', gapBefore: 'hidden', rawOf: 'hidden', sourceOf: 'hidden' };
    const position = { value: 'hidden' };
    const root = tree({ type: 'paragraph', source, position, depth: 'hidden', children: [] });
    expect(count(root, 'hidden')).toBe(0);
  });

  it('gives a node with nothing to read one token of its kind', () => {
    expect(tokenCounts(tree({ type: 'thematicBreak' })).size).toBe(1);
    const two = tree({ type: 'thematicBreak' }, { type: 'thematicBreak' });
    expect([...tokenCounts(two).values()]).toEqual([2]);
    const kinds = tree({ type: 'thematicBreak' }, { type: 'break' });
    expect(tokenCounts(kinds).size).toBe(2);
  });

  it('gives an image a token of its own as well, so a bare one still counts', () => {
    expect(tokenCounts(tree({ type: 'image' })).size).toBe(1);
    expect(tokenCounts(tree({ type: 'image', url: 'a' })).size).toBe(2);
  });

  it('gives a node with words or children no token of its kind', () => {
    expect(tokenCounts(tree(text('a'))).size).toBe(1);
    expect(tokenCounts(tree({ type: 'code', value: 'a' })).size).toBe(1);
  });

  it('cannot tell a marker of its own from a word on the page', () => {
    const typed = tree(text('thematicBreak'));
    const rule = tree({ type: 'thematicBreak' });
    expect(unexplainedTokens(typed, rule, typed, rule)).toBeGreaterThan(0);
    expect([...tokenCounts(rule).keys()]).not.toContain('thematicBreak');
  });

  it('sees no change in a reformat', () => {
    const one = parsed('- one\n- **two**\n\n```js\nthree\n```\n', 'md');
    const two = parsed('* one\n* __two__\n\n~~~js\nthree\n~~~\n', 'md');
    expect(tokenCounts(one)).toEqual(tokenCounts(two));
  });

  it('walks a tree deeper than any stack', () => {
    let node: unknown = { type: 'text', value: 'bottom' };
    for (let depth = 0; depth < 200_000; depth += 1) {
      node = { type: 'blockquote', children: [node] };
    }
    expect(count(tree(node), 'bottom')).toBe(1);
  });
});
