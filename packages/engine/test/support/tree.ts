import type { MdxBlock, MdxRoot, ReaderPage, ReaderUnit } from '@drefyn/mdx';
import { chunkNode, type Chunk, type ChunkOptions } from '../../src/index.ts';

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

// One unit for each block, as the host gives for these plain trees, so a unit index is a block
// index. The host's own tests prove its units are the render's text.
export const unitsOf = (root: MdxRoot): readonly ReaderUnit[] =>
  root.children.map((block) =>
    block.type === 'heading'
      ? { heading: { depth: block.depth, text: textOf(block) }, text: textOf(block) }
      : { text: textOf(block) },
  );

export const readerOf = (root: MdxRoot): ReaderPage => ({ state: 'ok', units: unitsOf(root) });

export const chunkTree = (root: MdxRoot, options: ChunkOptions): readonly Chunk[] =>
  chunkNode(readerOf(root), options);

type Sectioned = MdxRoot | readonly ReaderUnit[];

const headingsIn = (page: Sectioned): readonly boolean[] =>
  'children' in page
    ? page.children.map(({ type }) => type === 'heading')
    : page.map(({ heading }) => heading !== undefined);

// A section runs from one heading to the next, and whatever comes before the first is section 0.
export function sectionOf(page: Sectioned, index: number): number {
  return headingsIn(page)
    .slice(0, index + 1)
    .filter(Boolean).length;
}

// Chunks by the section they start in, without ord, which moves whenever an earlier one splits.
export function chunksBySection(
  page: Sectioned,
  chunks: readonly Chunk[],
): ReadonlyMap<number, readonly Omit<Chunk, 'ord'>[]> {
  let headings = 0;
  const sectionAt = headingsIn(page).map((heading) => {
    if (heading) headings += 1;
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
