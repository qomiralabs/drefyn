import { describe, expect, it } from 'vitest';
import { MdxPrintError, rawOf, serialize } from '../src/index.ts';
import type { BlockSource, MdxBlock, MdxRoot } from '../src/index.ts';
import { sourceOf, tailOf } from '../src/canonical.ts';
import { parsed } from './helpers.ts';
import { allNew, without, withChild, withoutSource } from './print-helpers.ts';

const SOURCE = 'One\n\nTwo\n';
const BOM = String.fromCharCode(0xfeff);

const newBlock = (markdown: string, dialect: 'md' | 'mdx' = 'md'): MdxBlock => {
  const [block] = allNew(parsed(markdown, dialect)).children;
  if (block === undefined) throw new Error('no block');
  return block;
};

const withText = (block: MdxBlock, value: string): MdxBlock =>
  ({ ...block, children: [{ type: 'text', value }] }) as MdxBlock;

const insert = (root: MdxRoot, index: number, block: MdxBlock): MdxRoot => ({
  ...root,
  children: [...root.children.slice(0, index), block, ...root.children.slice(index)],
});

describe('serialize', () => {
  it('prints a block whose tree moved on from its source', () => {
    const stale = withChild(
      parsed(SOURCE, 'md'),
      1,
      (block) =>
        ({
          ...block,
          type: 'heading',
          depth: 1,
        }) as MdxBlock,
    );
    expect(serialize(stale)).toBe('One\n\n# Two\n');
  });

  it('prints a new block, which has no bytes of its own', () => {
    const fresh = withChild(parsed(SOURCE, 'md'), 0, withoutSource);
    expect(serialize(fresh)).toBe('One\n\nTwo\n');
  });

  it('keeps every other byte of the file when one block changes', () => {
    const source = '---\ntitle:   a\n---\n\n\n* keep\n* me\n\n\nold   word\n\n\n__keep__ me\n  \n';
    const root = parsed(source, 'md');
    const edited = withChild(root, 2, (block) => withText(block, 'new word'));
    expect(serialize(edited)).toBe(source.replace('old   word', 'new word'));
  });

  it('prints an edit that lands back on the old tree with its old bytes', () => {
    const root = parsed('old   word\n', 'md');
    const same = withChild(root, 0, (block) => withText(block, 'old   word'));
    expect(serialize(same)).toBe('old   word\n');
  });

  it('reprints a stale block as LF inside a CRLF file', () => {
    const root = parsed('a\r\n\r\nb\r\nc\r\n', 'md');
    const edited = withChild(root, 1, (block) => withText(block, 'x\r\ny'));
    expect(serialize(edited)).toBe('a\r\n\r\nx\r\ny\r\n');
  });

  it('separates new blocks with the file line ending', () => {
    const root = parsed('a\r\n', 'md');
    expect(serialize(insert(root, 1, newBlock('b\n')))).toBe('a\r\n\r\nb\r\n');
  });

  it('prints blocks into an empty file', () => {
    const root = parsed('', 'md');
    expect(serialize(insert(root, 0, newBlock('a\n')))).toBe('a');
  });

  it('prints a page of nothing but new blocks with one blank line between them', () => {
    expect(serialize(allNew(parsed('a\n\n\n\n* b\n', 'md')))).toBe('a\n\n- b\n');
  });

  it('names the block by index and carries no content', () => {
    const root = insert(parsed(SOURCE, 'md'), 1, { type: 'mdxjsEsm', value: 'Two' } as MdxBlock);
    try {
      serialize(root);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'mdx.block_not_printable', blockIndex: 1 });
      expect(String(error)).not.toContain('Two');
    }
  });
});

describe('a byte order mark', () => {
  it('stays first when a block goes in before the block that held it', () => {
    const root = parsed(`${BOM}a\n`, 'md');
    expect(serialize(insert(root, 0, newBlock('b\n')))).toBe(`${BOM}b\n\na\n`);
  });

  it('stays first when the file had no blocks', () => {
    const root = parsed(`${BOM}\n`, 'md');
    expect(serialize(insert(root, 0, newBlock('a\n')))).toBe(`${BOM}a\n`);
  });
});

describe('frontmatter', () => {
  it('prints an edit in place', () => {
    const root = parsed(`${BOM}---\na: 1\n---\n\nb\n`, 'md');
    const edited = withChild(root, 0, (block) => ({ ...block, value: 'a: 2' }) as MdxBlock);
    expect(serialize(edited)).toBe(`${BOM}---\na: 2\n---\n\nb\n`);
  });

  it('refuses to sit anywhere but first, where it would parse as something else', () => {
    const root = parsed('---\na: 1\n---\n\nb\n', 'md');
    expect(() => serialize(insert(root, 0, newBlock('c\n')))).toThrow(
      expect.objectContaining({ blockIndex: 1 }),
    );
    expect(() => serialize(insert(parsed('b\n', 'md'), 1, newBlock('---\na: 1\n---\n')))).toThrow(
      MdxPrintError,
    );
  });
});

describe('a gap with no blank line', () => {
  const edit = (source: string, index: number, value: string, dialect: 'md' | 'mdx' = 'md') =>
    serialize(withChild(parsed(source, dialect), index, (block) => withText(block, value)));

  it('stays beside a block that ends itself', () => {
    expect(edit('# a\nb\n', 1, 'c')).toBe('# a\nc\n');
    expect(edit('```\nx\n```\nb\n', 1, 'c')).toBe('```\nx\n```\nc\n');
    expect(edit('---\nb\n', 1, 'c')).toBe('---\nc\n');
    expect(edit('b\n# a\n', 0, 'c')).toBe('c\n# a\n');
  });

  it('stays between two definitions', () => {
    const root = parsed('[a]: b\n[c]: d\n', 'md');
    const edited = withChild(root, 1, (block) => ({ ...block, url: 'e' }) as MdxBlock);
    expect(serialize(edited)).toBe('[a]: b\n[c]: e\n');
  });

  it('stays when a paragraph is followed by a fence', () => {
    expect(edit('b\n```\nx\n```\n', 0, 'c')).toBe('c\n```\nx\n```\n');
  });

  it('opens up when a block stops ending itself', () => {
    const root = parsed('# a\nb\n', 'md');
    const edited = withChild(root, 0, (block) =>
      withText({ ...block, type: 'paragraph' } as MdxBlock, 'a'),
    );
    expect(serialize(edited)).toBe('a\n\nb\n');
  });

  it('opens up before a thematic break, which would make a heading of the text above', () => {
    const root = parsed('# a\n---\n', 'md');
    const edited = withChild(root, 0, (block) =>
      withText({ ...block, type: 'paragraph' } as MdxBlock, 'a'),
    );
    expect(serialize(edited)).toBe('a\n\n---\n');
  });

  it('opens up between neighbours that a delete left touching', () => {
    const root = parsed('a\n\n# b\nc\n', 'md');
    expect(serialize(without(root, 1))).toBe('a\n\nc\n');
  });

  it('opens up after a list that would take the next line as its own', () => {
    const root = parsed('- a\n\n# b\nc\n', 'md');
    expect(serialize(without(root, 1))).toBe('- a\n\nc\n');
    const quote = parsed('> - a\n\n# b\nc\n', 'md');
    expect(serialize(without(quote, 1))).toBe('> - a\n\nc\n');
  });

  it('keeps a gap that already has a blank line in it', () => {
    expect(edit('a\n  \n\n\nb\n', 1, 'c')).toBe('a\n  \n\n\nc\n');
    expect(edit('a\r\n\r\nb\r\n', 1, 'c')).toBe('a\r\n\r\nc\r\n');
  });
});

describe('neighbouring lists', () => {
  it('gives a new list the other marker so it cannot join the one before', () => {
    const root = parsed('- a\n', 'md');
    expect(serialize(insert(root, 1, newBlock('- b\n')))).toBe('- a\n\n* b\n');
  });

  it('gives a new list the other marker so it cannot join the one after', () => {
    const root = parsed('- a\n', 'md');
    expect(serialize(insert(root, 0, newBlock('- b\n')))).toBe('* b\n\n- a\n');
  });

  it('finds a third marker when both sides are taken', () => {
    const root = parsed('- a\n\n* b\n', 'md');
    expect(serialize(insert(root, 1, newBlock('- c\n')))).toBe('- a\n\n+ c\n\n* b\n');
  });

  it('does the same for ordered lists', () => {
    const root = parsed('1. a\n', 'md');
    expect(serialize(insert(root, 1, newBlock('1. b\n')))).toBe('1. a\n\n1) b\n');
    const close = parsed('1) a\n', 'md');
    expect(serialize(insert(close, 1, newBlock('1. b\n')))).toBe('1) a\n\n1. b\n');
  });

  it('leaves an ordered and a bullet list alone', () => {
    const root = parsed('- a\n', 'md');
    expect(serialize(insert(root, 1, newBlock('1. b\n')))).toBe('- a\n\n1. b\n');
  });

  it('reprints an untouched list that a delete left beside its twin', () => {
    const root = parsed('- a\n\nb\n\n- c\n', 'md');
    expect(serialize(without(root, 1))).toBe('- a\n\n* c\n');
  });

  it('refuses when ordered lists on both sides leave no marker', () => {
    const root = parsed('1. a\n\n1) b\n', 'md');
    expect(() => serialize(insert(root, 1, newBlock('1. c\n')))).toThrow(
      expect.objectContaining({ blockIndex: 1 }),
    );
  });

  it('never touches two lists that were already different', () => {
    const source = '- a\n* b\n- c\n';
    expect(serialize(parsed(source, 'md'))).toBe(source);
  });
});

describe('bytes bound to the tree', () => {
  // A stale tree prints, but bytes that changed under their own hash mean the row is damaged.
  const SCRIPT = '<script>steal()</script>';
  const withSource = (root: MdxRoot, change: (source: BlockSource) => BlockSource) =>
    withChild(root, 0, (block) => {
      if (block.source === undefined) throw new Error('no source');
      return { ...block, source: change(block.source) };
    });

  it('refuses changed raw text', () => {
    const changed = withSource(parsed(SOURCE, 'md'), (source) => ({ ...source, raw: SCRIPT }));
    expect(() => serialize(changed)).toThrow(MdxPrintError);
  });

  it('refuses a changed gap', () => {
    const changed = withSource(parsed(SOURCE, 'md'), (source) => ({
      ...source,
      gapBefore: '\n',
    }));
    expect(() => serialize(changed)).toThrow(MdxPrintError);
  });

  it('refuses a changed tail, and names the place after the last block', () => {
    const root = parsed(SOURCE, 'md');
    expect(() => serialize({ ...root, tail: '\n\n' })).toThrow(
      expect.objectContaining({ blockIndex: 2 }),
    );
  });

  it('refuses a new tree with the old bytes, even with rawOf recomputed', () => {
    const changed = withChild(parsed(SOURCE, 'md'), 0, (block) => {
      const tree = { ...block, type: 'thematicBreak' } as MdxBlock;
      if (block.source === undefined) throw new Error('no source');
      return { ...tree, source: { ...block.source, rawOf: rawOf(tree) } };
    });
    expect(() => serialize(changed)).toThrow(MdxPrintError);
  });

  it('refuses text in a gap even when every hash was forged to match', () => {
    const changed = withSource(parsed(SOURCE, 'md'), (source) => ({
      ...source,
      gapBefore: SCRIPT,
      sourceOf: sourceOf(source.rawOf, SCRIPT, source.raw),
    }));
    expect(() => serialize(changed)).toThrow(MdxPrintError);
  });

  it('refuses text in the tail even when its hash was forged to match', () => {
    const root = parsed(SOURCE, 'md');
    expect(() => serialize({ ...root, tail: SCRIPT, tailOf: tailOf(SCRIPT) })).toThrow(
      MdxPrintError,
    );
  });

  it('refuses parser data at any depth, which a renderer would honour', () => {
    const root = parsed(SOURCE, 'md');
    const nested = withChild(root, 0, (block) => {
      const copy = structuredClone(block) as MdxBlock & { children: { data?: unknown }[] };
      const [first] = copy.children;
      if (first === undefined) throw new Error('no child');
      first.data = { hName: 'script' };
      return copy;
    });
    expect(() => serialize(nested)).toThrow(MdxPrintError);
  });
});

describe('rawOf', () => {
  const hash = (source: string) => {
    const block = parsed(source, 'md').children[0];
    if (block === undefined) throw new Error('no block');
    return rawOf(block);
  };

  it('ignores line endings, so changing them is not a content change', () => {
    expect(hash('a\r\nb\n')).toBe(hash('a\nb\n'));
    expect(hash('```\na\r\nb\r\n```\n')).toBe(hash('```\na\nb\n```\n'));
  });

  it('treats a line ending in a code span as a space, as CommonMark renders it', () => {
    expect(hash('`a\nb`\n')).toBe(hash('`a b`\n'));
  });

  it('ignores formatting that parses to the same tree', () => {
    expect(hash('- a\n- b\n')).toBe(hash('* a\n* b\n'));
    expect(hash('# a\n')).toBe(hash('# a #\n'));
  });

  it('changes with the content', () => {
    expect(hash('one\n')).not.toBe(hash('two\n'));
    expect(hash('`a\nb`\n')).not.toBe(hash('a b\n'));
  });

  it('does not read the source it sits beside', () => {
    const block = parsed('one\n', 'md').children[0];
    if (block === undefined) throw new Error('no block');
    expect(rawOf(withoutSource(block))).toBe(rawOf(block));
  });
});
