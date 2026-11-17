import { digest, sourceOf, tailOf } from './canonical.ts';
import { MdxPrintError, printCanonical, printWith } from './print.ts';
import { DEFAULT_LIMITS } from './policy.ts';
import { checkTree } from './tree-limits.ts';
import type { MdxBlock, MdxLimits, MdxRoot } from './types.ts';

const BOM = String.fromCharCode(0xfeff);

function boms(text: string): string {
  let end = 0;
  while (text.startsWith(BOM, end)) end += BOM.length;
  return text.slice(0, end);
}

// The parser only ever leaves a leading BOMs and whitespace outside blocks. Checked as well as
// hashed because a hash has no key, so text here is refused even with a matching hash.
function isBlankSpace(text: string): boolean {
  for (let index = boms(text).length; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code !== 32 && code !== 9 && code !== 10 && code !== 13) return false;
  }
  return true;
}

// The raw text, if it can still stand for this block. A tree that moved on is an edit and
// reprints, but bytes that no longer match their own hashes are a damaged row, and printing the
// tree would hide that. Those hashes catch staleness, not a writer who recomputes them.
function untouchedBytes(block: MdxBlock, index: number): string | undefined {
  const { rawOf, plain } = digest(block);
  if (!plain) throw new MdxPrintError(index);
  const { source } = block;
  if (source === undefined) return undefined;
  const whole = source.sourceOf === sourceOf(source.rawOf, source.gapBefore, source.raw);
  if (!whole || !isBlankSpace(source.gapBefore)) throw new MdxPrintError(index);
  return source.rawOf === rawOf ? source.raw : undefined;
}

type ListMarker = '-' | '*' | '+' | '.' | ')';

const LIST_MARKER = /^\s*(?:([-*+])|\d+([.)]))/;

const markerOf = (text: string): ListMarker | undefined => {
  const match = LIST_MARKER.exec(text);
  return (match?.[1] ?? match?.[2]) as ListMarker | undefined;
};

interface Placed {
  readonly block: MdxBlock;
  readonly text: string;
  readonly verbatim: boolean;
}

function freeMarker(ordered: boolean, taken: readonly (ListMarker | undefined)[]) {
  const choices: readonly ListMarker[] = ordered ? ['.', ')'] : ['-', '*', '+'];
  return choices.find((marker) => !taken.includes(marker));
}

// Two neighbouring lists with one marker are one list to a parser, so a block's own tree is not
// enough here: this is the only case where an untouched block has to change bytes.
function place(
  root: MdxRoot,
  block: MdxBlock,
  index: number,
  previous: Placed | undefined,
): Placed {
  const { dialect, children } = root;
  const raw = untouchedBytes(block, index);
  const verbatim = raw !== undefined;
  const text = raw ?? printCanonical(block, dialect);
  // Opening a file with --- starts frontmatter, and the next one closes it.
  if (block.type === 'thematicBreak' && index === 0 && !verbatim) {
    return { block, text: printWith(block, dialect, { rule: '*' }), verbatim };
  }
  if (block.type !== 'list') return { block, text, verbatim };

  const ordered = block.ordered === true;
  const next = children[index + 1];
  // Bullets and numbers share no marker, so only the neighbour's kind needs checking.
  const taken = [
    previous?.block.type === 'list' ? markerOf(previous.text) : undefined,
    next?.type === 'list' && next.source !== undefined ? markerOf(next.source.raw) : undefined,
  ];
  const mine = markerOf(text);
  if (verbatim ? mine !== taken[0] : !taken.includes(mine)) return { block, text, verbatim };

  const marker = freeMarker(ordered, taken);
  if (marker === undefined) throw new MdxPrintError(index);
  const override = ordered
    ? { bulletOrdered: marker as '.' | ')' }
    : { bullet: marker as '-' | '*' | '+' };
  return { block, text: printWith(block, dialect, override), verbatim: false };
}

// \r(?!\n) keeps one CRLF from reading as two endings when the match backs up.
export const BLANK_LINE = /(?:\r\n|\r(?!\n)|\n)[ \t]*(?:\r\n|\r|\n)/;
const ATX_OR_FENCE = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|[`~])/;
// Only these lists can interrupt a paragraph: an empty item or a later number cannot.
const INTERRUPTING_LIST = /^ {0,3}(?:[-+*]|1[.)])[ \t]+\S/;
const FENCE = /^ {0,3}[`~]/;

// A block that cannot swallow the line after it, whatever that line holds.
function endsItself({ block, text }: Placed): boolean {
  switch (block.type) {
    case 'code':
      return FENCE.test(text);
    case 'heading':
    case 'thematicBreak':
    case 'yaml':
    case 'mdxFlowExpression':
    case 'mdxJsxFlowElement':
      return true;
    default:
      return false;
  }
}

interface Flow {
  readonly type: string;
  readonly children?: readonly Flow[];
}

function endsInParagraph({ type, children }: Flow): boolean {
  if (type === 'list' || type === 'listItem' || type === 'blockquote') {
    const last = children?.at(-1);
    return last !== undefined && endsInParagraph(last);
  }
  return type === 'paragraph';
}

// Parsers keep a paragraph going into the next line, however deep it sits, so two blocks like
// this cannot have been neighbours in the file and the gap cannot be what the author wrote.
const fuses = (before: Placed, after: Placed) =>
  after.block.type === 'paragraph' && endsInParagraph(before.block);

function oneLineIsEnough(before: Placed, after: Placed): boolean {
  if (endsItself(before)) return true;
  if (before.block.type === 'definition') return after.block.type === 'definition';
  if (ATX_OR_FENCE.test(after.text)) return true;
  return before.block.type === 'paragraph' && INTERRUPTING_LIST.test(after.text);
}

function gapBetween(before: Placed, after: Placed, kept: string, blank: string): string {
  if (BLANK_LINE.test(kept)) return kept;
  if (before.verbatim && after.verbatim) return fuses(before, after) ? blank : kept;
  return oneLineIsEnough(before, after) ? kept : blank;
}

const inFile = (text: string, newline: string) => text.replaceAll('\n', newline);

function placeOrRefuse(
  root: MdxRoot,
  block: MdxBlock,
  index: number,
  previous: Placed | undefined,
): Placed {
  try {
    return place(root, block, index, previous);
  } catch (error) {
    // The hash walks the tree too, so a tree too deep to print can stop there first.
    if (error instanceof MdxPrintError || error instanceof RangeError) {
      throw new MdxPrintError(index);
    }
    throw error;
  }
}

// Pure: the same tree always gives the same bytes. A block prints its raw text only while its
// tree still hashes to rawOf, so stale bytes cannot reach git; anything else takes the one
// canonical printer. Gaps stay as written unless the blocks beside them have changed.
export function serialize(root: MdxRoot, limits: MdxLimits = DEFAULT_LIMITS): string {
  checkTree(root.children, limits);
  const newline = root.eol === 'crlf' ? '\r\n' : '\n';
  const blank = newline + newline;
  let bom = '';
  let output = '';
  let previous: Placed | undefined;
  for (const [index, block] of root.children.entries()) {
    const placed = placeOrRefuse(root, block, index, previous);
    const written = block.source?.gapBefore ?? '';
    const leading = boms(written);
    const kept = written.slice(leading.length);
    bom ||= leading;
    if (block.type === 'yaml' && index > 0) throw new MdxPrintError(index);
    const gap =
      previous === undefined
        ? kept
        : block.source === undefined
          ? blank
          : gapBetween(previous, placed, kept, blank);
    output += gap + (placed.verbatim ? placed.text : inFile(placed.text, newline));
    previous = placed;
  }
  if (root.tailOf !== tailOf(root.tail) || !isBlankSpace(root.tail)) {
    throw new MdxPrintError(root.children.length);
  }
  const trailing = boms(root.tail);
  return (bom || trailing) + output + root.tail.slice(trailing.length);
}
