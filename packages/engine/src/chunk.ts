import type { MdxBlock } from '@drefyn/mdx';
import type { NodeContent } from './content.ts';

export interface ChunkOptions {
  // Close a chunk before it passes this.
  readonly targetChars: number;
  // No chunk ever passes this.
  readonly maxChars: number;
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

// A cut here would leave half a surrogate pair, which no column or hash can hold honestly.
const splitsPair = (text: string, at: number): boolean => {
  const before = text.charCodeAt(at - 1);
  const after = text.charCodeAt(at);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
};

const cutPoint = (text: string, at: number): number => (splitsPair(text, at) ? at - 1 : at);

function headingText(block: MdxBlock): string {
  let text = '';
  const stack: unknown[] = [block];
  while (stack.length > 0) {
    const { value, children } = stack.pop() as { value?: unknown; children?: unknown };
    if (typeof value === 'string') text += value;
    if (Array.isArray(children)) stack.push(...(children as unknown[]).toReversed());
    if (text.length >= MAX_HEADING_CHARS) break;
  }
  return text.length > MAX_HEADING_CHARS ? text.slice(0, cutPoint(text, MAX_HEADING_CHARS)) : text;
}

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

// Pure, and it reads only the source each block already carries, so the same tree always gives
// the same chunks and the bodies join back into the page. Boundaries follow blocks and restart at
// every heading: an edit can only move text within its own section, which is what keeps most
// chunks, and their embeddings, the same from one version to the next. Sizes are UTF-16 units.
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

  const add = (blockPath: string, body: string) => {
    chunks.push({ ord: chunks.length, blockPath, headingPath: openHeadings, body });
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
        add(parts.length === 1 ? blockPath : `${blockPath}.${String(at)}`, part);
      });
      return;
    }
    if (open.length + text.length > targetChars) close();
    if (open === '') openPath = blockPath;
    open += text;
  };

  content.children.forEach((block, index) => {
    if (block.type === 'heading') {
      close();
      while ((headings.at(-1)?.depth ?? 0) >= block.depth) headings.pop();
      headings.push({ depth: block.depth, text: headingText(block) });
      openHeadings = headings.map(({ text }) => text);
    }
    if (block.source !== undefined) {
      place(String(index), block.source.gapBefore + block.source.raw);
    }
  });

  // A final newline should not cost a row of its own.
  const { tail } = content;
  if (open.length + tail.length <= maxChars) {
    if (open === '') openPath = String(content.children.length);
    open += tail;
  } else if (tail !== '') {
    place(String(content.children.length), tail);
  }
  close();
  return chunks;
}
