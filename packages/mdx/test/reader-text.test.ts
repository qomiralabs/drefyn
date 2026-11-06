import { describe, expect, it } from 'vitest';
import { readerBlocks } from '../src/index.ts';
import type { MdxBlock, MdxRoot } from '../src/index.ts';

const NONE = { components: new Set<string>() };

const rootOf = (children: readonly unknown[]): MdxRoot =>
  ({
    type: 'root',
    astVersion: 1,
    dialect: 'md',
    eol: 'lf',
    children: children as readonly MdxBlock[],
    tail: '',
    tailOf: '',
  }) as MdxRoot;

const text = (value: string) => ({ type: 'text', value });
const paragraph = (...children: readonly unknown[]) => ({ type: 'paragraph', children });
const html = (value: string) => ({ type: 'html', value });

const read = (...children: readonly unknown[]) => readerBlocks(rootOf(children), NONE);

describe('readerBlocks', () => {
  it('gives one entry a block, so a caller can place each one', () => {
    expect(read(paragraph(text('a')), html('<!-- b -->'), paragraph(text('c')))).toEqual([
      'a',
      '',
      'c',
    ]);
  });

  it('shows nothing for a node type it does not know', () => {
    expect(read({ type: 'someFutureNode', value: 'x', children: [text('y')] })).toEqual(['']);
  });

  it('joins table cells with a tab and rows with a line', () => {
    const row = (...cells: string[]) => ({
      type: 'tableRow',
      children: cells.map((cell) => ({ type: 'tableCell', children: [text(cell)] })),
    });
    const table = { type: 'table', align: [null, null], children: [row('a', 'b'), row('c', 'd')] };
    expect(read(table)).toEqual(['a\tb\nc\td']);
  });

  it('turns a hard break into a line', () => {
    expect(read(paragraph(text('a'), { type: 'break' }, text('b')))).toEqual(['a\nb']);
  });

  it('reads alt text and not the rest of an image', () => {
    expect(read(paragraph({ type: 'image', url: 'u', title: 't', alt: 'seen' }))).toEqual(['seen']);
  });

  it.each([
    ['a comment', '<!-- <template> -->'],
    ['a void tag', '<br>'],
    ['a void tag with a slash', '<img src="a"/>'],
    ['a declaration', '<!DOCTYPE html>'],
    ['an instruction', '<?php template ?>'],
    ['a close with no open', '</div>'],
    ['a closed tag', '<b>x</b>'],
    ['a lone angle bracket', '< b'],
  ])('reads on after %s', (_name, value) => {
    expect(read(html(value), paragraph(text('after')))).toEqual(['', 'after']);
  });

  it.each([
    ['an unclosed comment', '<!-- never'],
    ['an unclosed tag', '<div title="'],
    ['an unclosed open quote', "<div title='a>"],
    ['plaintext, which nothing closes', '<plaintext></plaintext>'],
    ['a raw text element with no close', '<script>'],
    ['a stuck declaration', '<!DOCTYPE'],
  ])('hides the rest of the page after %s', (_name, value) => {
    expect(read(html(value), paragraph(text('after')))).toEqual(['', '']);
  });

  it('nests the same tag', () => {
    expect(
      read(html('<div><div></div>'), paragraph(text('in')), html('</div>'), paragraph(text('out'))),
    ).toEqual(['', '', '', 'out']);
  });

  it('closes through what was left open inside', () => {
    expect(read(html('<div><b></div>'), paragraph(text('out')))).toEqual(['', 'out']);
  });

  it('finds a raw text close in any case, past its end tag spaces', () => {
    expect(read(html('<STYLE>a</style  >'), paragraph(text('out')))).toEqual(['', 'out']);
  });

  it('holds a raw text element open to a close tag only', () => {
    expect(read(html('<style></styled>'), paragraph(text('in')))).toEqual(['', '']);
  });

  it('walks a registered component and nothing else', () => {
    const element = (name: string | null) => ({
      type: 'mdxJsxFlowElement',
      name,
      attributes: [],
      children: [paragraph(text(String(name)))],
    });
    const root = rootOf([element('Note'), element('Foo'), element(null)]);
    expect(readerBlocks(root, { components: new Set(['Note']) })).toEqual(['Note', '', '']);
  });

  it('reads footnotes that a shown footnote references', () => {
    const reference = (identifier: string) => ({ type: 'footnoteReference', identifier });
    const note = (identifier: string, ...children: readonly unknown[]) => ({
      type: 'footnoteDefinition',
      identifier,
      children: [paragraph(...children)],
    });
    expect(
      read(
        paragraph(text('a'), reference('ONE')),
        note('one', text('b'), reference('two')),
        note('two', text('c')),
        note('three', text('d')),
      ),
    ).toEqual(['a', 'b', 'c', '']);
  });

  it('does not change its input', () => {
    const root = rootOf([html('<b>'), paragraph(text('x'))]);
    const before = JSON.stringify(root);
    readerBlocks(root, NONE);
    expect(JSON.stringify(root)).toBe(before);
  });

  it('keeps a hostile page linear', () => {
    const value = '<a title="'.repeat(50_000);
    const started = performance.now();
    read(html(value), html('<b>'.repeat(50_000)), html('</b>'.repeat(50_000)));
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
