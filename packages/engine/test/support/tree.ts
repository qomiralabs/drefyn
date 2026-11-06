import type { MdxBlock, MdxRoot } from '@drefyn/mdx';

export interface BlockSpec {
  readonly raw: string;
  readonly gap?: string;
  // Sets a heading of this level, with its plain text.
  readonly heading?: { readonly depth: 1 | 2 | 3 | 4 | 5 | 6; readonly text: string };
}

// Only the fields chunking reads carry meaning, so these trees skip the parser and its hashes.
export function treeOf(specs: readonly BlockSpec[], tail = ''): MdxRoot {
  const children = specs.map(({ raw, gap, heading }, index): MdxBlock => {
    const source = { raw, gapBefore: gap ?? (index === 0 ? '' : '\n\n'), rawOf: '', sourceOf: '' };
    return heading === undefined
      ? { type: 'paragraph', children: [{ type: 'text', value: raw }], source }
      : {
          type: 'heading',
          depth: heading.depth,
          children: [{ type: 'text', value: heading.text }],
          source,
        };
  });
  return { type: 'root', astVersion: 1, dialect: 'md', eol: 'lf', children, tail, tailOf: '' };
}

export const sourceOf = (root: MdxRoot): string =>
  root.children.reduce(
    (text, { source }) => text + (source?.gapBefore ?? '') + (source?.raw ?? ''),
    '',
  ) + root.tail;
