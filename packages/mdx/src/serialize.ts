import { rawOf } from './canonical.ts';
import type { MdxRoot } from './types.ts';

export class MdxPrintError extends Error {
  readonly code = 'mdx.block_not_printable';
  readonly blockIndex: number;

  constructor(blockIndex: number) {
    super(`mdx.block_not_printable: block ${blockIndex}`);
    this.name = 'MdxPrintError';
    this.blockIndex = blockIndex;
  }
}

// Pure: the same tree always gives the same bytes. A block's raw text is only trusted while
// its tree still hashes to rawOf, so git and the rendered page can never disagree.
export function serialize(root: MdxRoot): string {
  let output = '';
  for (const [index, block] of root.children.entries()) {
    const { source } = block;
    // TODO(#279): print through the canonical printer instead of refusing.
    if (source?.rawOf !== rawOf(block)) throw new MdxPrintError(index);
    output += source.gapBefore + source.raw;
  }
  return output + root.tail;
}
