import { readerBlocks } from '@drefyn/mdx';
import type { NodeContent } from './content.ts';

export interface ChunkOptions {
  // Close a chunk before it passes this.
  readonly targetChars: number;
  // No chunk ever passes this.
  readonly maxChars: number;
  // The registry pages render with. Without it no component's children are shown.
  readonly components?: ReadonlySet<string>;
}

export interface Chunk {
  readonly ord: number;
  // The top level block the chunk starts at, and which part when one block was split: '3', '3.1'.
  readonly blockPath: string;
  readonly headingPath: readonly string[];
  readonly body: string;
}

// A heading path is copied onto every chunk under it, so without this one very long heading
// would multiply through a whole section.
const MAX_HEADING_CHARS = 200;

// The same path repeats on every row of a section, and a page of bare headings gives about 25,000
// rows, so no cap on one heading stops a save growing by tens of megabytes. This is about the
// page's own size at worst, and far past what a long honest page spends.
const MAX_HEADING_PATH_CHARS_PER_PAGE = 262_144;

const BLOCK_GAP = '\n\n';

// A cut here would leave half a surrogate pair, which no column or hash can hold honestly.
const splitsPair = (text: string, at: number): boolean => {
  const before = text.charCodeAt(at - 1);
  const after = text.charCodeAt(at);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
};

const cutPoint = (text: string, at: number): number => (splitsPair(text, at) ? at - 1 : at);

const headingText = (text: string): string =>
  text.length > MAX_HEADING_CHARS ? text.slice(0, cutPoint(text, MAX_HEADING_CHARS)) : text;

const NO_COMPONENTS: ReadonlySet<string> = new Set();

function linesOf(text: string): string[] {
  const lines: string[] = [];
  let from = 0;
  while (from < text.length) {
    const end = text.indexOf('\n', from);
    const to = end < 0 ? text.length : end + 1;
    lines.push(text.slice(from, to));
    from = to;
  }
  return lines;
}

function sliced(line: string, maxChars: number): string[] {
  const slices: string[] = [];
  let rest = line;
  while (rest.length > maxChars) {
    const at = cutPoint(rest, maxChars);
    slices.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  slices.push(rest);
  return slices;
}

// Line ends first, as code and tables read best whole. A single line past the cap has no good
// place to break, so it is cut at the cap.
function splitLong(text: string, { targetChars, maxChars }: ChunkOptions): string[] {
  const parts: string[] = [];
  let open = '';
  for (const line of linesOf(text)) {
    if (open !== '' && open.length + line.length > targetChars) {
      parts.push(open);
      open = '';
    }
    if (line.length > maxChars) {
      parts.push(...sliced(line, maxChars));
    } else {
      open += line;
    }
  }
  if (open !== '') parts.push(open);
  return parts;
}

// Pure, and it reads only what a reader sees, so the same tree always gives the same chunks.
// Boundaries follow blocks and restart at every heading: an edit can only move text within its
// own section, which is what keeps most chunks, and their embeddings, the same from one version
// to the next. Sizes are UTF-16 units.
export function chunkNode(content: NodeContent, options: ChunkOptions): readonly Chunk[] {
  const { targetChars, maxChars } = options;
  // Two units is the least that can hold any character, and a smaller cap could not progress.
  if (targetChars < 1 || maxChars < 2 || targetChars > maxChars) {
    throw new RangeError('chunk sizes must satisfy 1 <= target <= max and 2 <= max');
  }

  const chunks: Chunk[] = [];
  const headings: { readonly depth: number; readonly text: string }[] = [];
  let open = '';
  let openPath = '';
  let openHeadings: readonly string[] = [];
  let openHeadingsCost = 0;
  let headingBudget = MAX_HEADING_PATH_CHARS_PER_PAGE;

  // Past the budget a chunk has no path. Its body still holds the text, so nothing is lost to
  // search. One to each element as well, because an empty string still costs a slot.
  const add = (blockPath: string, body: string) => {
    const fits = openHeadingsCost <= headingBudget;
    if (fits) headingBudget -= openHeadingsCost;
    const headingPath = fits ? openHeadings : [];
    chunks.push({ ord: chunks.length, blockPath, headingPath, body });
  };
  const close = () => {
    if (open !== '') add(openPath, open);
    open = '';
  };
  const place = (blockPath: string, text: string) => {
    if (text.length > targetChars) {
      close();
      const parts = splitLong(text, options);
      parts.forEach((part, at) => {
        if (part.trim() === '') return;
        add(parts.length === 1 ? blockPath : `${blockPath}.${String(at)}`, part);
      });
      return;
    }
    if (open.length + BLOCK_GAP.length + text.length > targetChars) close();
    if (open === '') openPath = blockPath;
    else open += BLOCK_GAP;
    open += text;
  };

  const texts = readerBlocks(content, { components: options.components ?? NO_COMPONENTS });
  content.children.forEach((block, index) => {
    const text = texts[index] ?? '';
    if (block.type === 'heading') {
      close();
      while ((headings.at(-1)?.depth ?? 0) >= block.depth) headings.pop();
      headings.push({ depth: block.depth, text: headingText(text) });
      openHeadings = headings.map(({ text }) => text);
      openHeadingsCost = openHeadings.reduce((sum, text) => sum + text.length + 1, 0);
    }
    if (text.trim() !== '') place(String(index), text);
  });
  close();
  return chunks;
}
