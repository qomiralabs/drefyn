import { digest, sourceOf, tailOf } from './canonical.ts';
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

const BOM = String.fromCharCode(0xfeff);

// The parser only ever leaves a leading BOMs and whitespace outside blocks. Checked as well as
// hashed because a hash has no key, so text here is refused even with a matching hash.
function isBlankSpace(text: string): boolean {
  let index = 0;
  while (text.startsWith(BOM, index)) index += BOM.length;
  for (; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code !== 32 && code !== 9 && code !== 10 && code !== 13) return false;
  }
  return true;
}

// Pure: the same tree always gives the same bytes. A block's raw text is only printed while
// its tree still hashes to rawOf and those bytes still hash to sourceOf, so stale bytes cannot
// reach git. Those hashes catch staleness, not a writer who recomputes them.
export function serialize(root: MdxRoot): string {
  let output = '';
  for (const [index, block] of root.children.entries()) {
    const { source } = block;
    const { rawOf, plain } = digest(block);
    // TODO(#279): print through the canonical printer instead of refusing.
    if (
      source?.rawOf !== rawOf ||
      !plain ||
      source.sourceOf !== sourceOf(rawOf, source.gapBefore, source.raw) ||
      !isBlankSpace(source.gapBefore)
    ) {
      throw new MdxPrintError(index);
    }
    output += source.gapBefore + source.raw;
  }
  if (root.tailOf !== tailOf(root.tail) || !isBlankSpace(root.tail)) {
    throw new MdxPrintError(root.children.length);
  }
  return output + root.tail;
}
