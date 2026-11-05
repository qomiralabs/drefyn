import { describe, expect, it } from 'vitest';
import { MdxPrintError, rawOf, serialize } from '../src/index.ts';
import type { MdxBlock, MdxRoot } from '../src/index.ts';
import { parsed } from './helpers.ts';

const SOURCE = 'One\n\nTwo\n';

function withoutSource(block: MdxBlock): MdxBlock {
  const copy = { ...block };
  delete copy.source;
  return copy;
}

function withChild(root: MdxRoot, index: number, change: (block: MdxBlock) => MdxBlock): MdxRoot {
  return {
    ...root,
    children: root.children.map((block, at) => (at === index ? change(block) : block)),
  };
}

describe('serialize', () => {
  it('refuses a block whose tree moved on from its source', () => {
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
    expect(() => serialize(stale)).toThrow(MdxPrintError);
    expect(() => serialize(stale)).toThrow('mdx.block_not_printable');
  });

  it('refuses a new block, which only the canonical printer can write', () => {
    const fresh = withChild(parsed(SOURCE, 'md'), 0, withoutSource);
    expect(() => serialize(fresh)).toThrow(MdxPrintError);
  });

  it('names the block by index and carries no content', () => {
    const fresh = withChild(parsed(SOURCE, 'md'), 1, withoutSource);
    try {
      serialize(fresh);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'mdx.block_not_printable', blockIndex: 1 });
      expect(String(error)).not.toContain('Two');
    }
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
