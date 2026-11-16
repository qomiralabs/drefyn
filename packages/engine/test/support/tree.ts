import type { MdxBlock, MdxRoot } from '@drefyn/mdx';
import type { Chunk } from '../../src/index.ts';

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

const textOf = (block: MdxBlock): string =>
  'children' in block
    ? block.children.map((child) => ('value' in child ? child.value : '')).join('')
    : '';

// What these trees show a reader, blocks a blank line apart.
export const visibleOf = (root: MdxRoot): string =>
  root.children
    .map(textOf)
    .filter((text) => text.trim() !== '')
    .join('\n\n');

// A section runs from one heading to the next, and whatever comes before the first is section 0.
export function sectionOf(root: MdxRoot, blockIndex: number): number {
  const upTo = root.children.slice(0, blockIndex + 1);
  return upTo.filter(({ type }) => type === 'heading').length;
}

// Chunks by the section they start in, without ord, which moves whenever an earlier one splits.
export function chunksBySection(
  root: MdxRoot,
  chunks: readonly Chunk[],
): ReadonlyMap<number, readonly Omit<Chunk, 'ord'>[]> {
  let headings = 0;
  const sectionAt = root.children.map(({ type }) => {
    if (type === 'heading') headings += 1;
    return headings;
  });

  // A short cap cuts one block into tens of thousands of chunks, so nothing here may copy the
  // chunks seen so far or walk the blocks again for each one.
  const sections = new Map<number, Omit<Chunk, 'ord'>[]>();
  for (const { blockPath, headingPath, body } of chunks) {
    const section = sectionAt[Number.parseInt(blockPath, 10)] ?? headings;
    const found = sections.get(section);
    if (found === undefined) sections.set(section, [{ blockPath, headingPath, body }]);
    else found.push({ blockPath, headingPath, body });
  }
  return sections;
}
