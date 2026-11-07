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

const VALUE_NODES: ReadonlySet<string> = new Set(['text', 'inlineCode', 'code']);
const ALT_NODES: ReadonlySet<string> = new Set(['image', 'imageReference']);

// TODO(#416): chunk text has to come from the render. This list cannot see raw HTML that wraps
// text across nodes, unknown components or orphan footnotes, so the chunk flag stays off.
// Each node whose children are read, and what goes between them. A list and not a filter: a node
// type added later stays out until someone adds it.
const CONTAINERS: ReadonlyMap<string, string> = new Map([
  ['paragraph', ''],
  ['heading', ''],
  ['emphasis', ''],
  ['strong', ''],
  ['delete', ''],
  ['link', ''],
  ['linkReference', ''],
  ['tableCell', ''],
  ['mdxJsxTextElement', ''],
  ['tableRow', '\t'],
  ['table', '\n'],
  ['blockquote', '\n'],
  ['list', '\n'],
  ['listItem', '\n'],
  ['footnoteDefinition', '\n'],
  ['mdxJsxFlowElement', '\n'],
]);

interface WalkedNode {
  readonly type?: unknown;
  readonly value?: unknown;
  readonly alt?: unknown;
  readonly children?: unknown;
}

// Read off the tree, never off a block's source: that holds frontmatter, comments, raw HTML, link
// targets and component props, and chunks go on to search, the assistant and MCP. Keeps its own
// stack, as a rollback reads a tree nothing has walked in this process. Separators sit on the
// stack with the nodes, so they come out in reading order.
function visibleText(block: MdxBlock, limit = Infinity): string {
  let text = '';
  const stack: (WalkedNode | string)[] = [block];
  while (stack.length > 0 && text.length < limit) {
    const item = stack.pop();
    if (typeof item === 'string') {
      text += item;
      continue;
    }
    const type = String(item?.type);
    const { value, alt, children } = item ?? {};
    const between = CONTAINERS.get(type);
    if (VALUE_NODES.has(type) && typeof value === 'string') text += value;
    else if (ALT_NODES.has(type) && typeof alt === 'string') text += alt;
    else if (type === 'break') text += '\n';
    else if (between !== undefined && Array.isArray(children)) {
      for (let at = children.length - 1; at >= 0; at -= 1) {
        stack.push(children[at] as WalkedNode);
        if (at > 0 && between !== '') stack.push(between);
      }
    }
  }
  return text;
}

function headingText(block: MdxBlock): string {
  const text = visibleText(block, MAX_HEADING_CHARS);
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

// Pure, so the same tree always gives the same chunks.
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
  // Shared out by section and not spent first come, so an edit that changes how many chunks one
  // section makes cannot take a heading path off a chunk in another.
  const sectionBudget = Math.floor(
    MAX_HEADING_PATH_CHARS_PER_PAGE /
      Math.max(1, content.children.filter(({ type }) => type === 'heading').length),
  );
  let headingBudget = sectionBudget;

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

  content.children.forEach((block, index) => {
    if (block.type === 'heading') {
      close();
      while ((headings.at(-1)?.depth ?? 0) >= block.depth) headings.pop();
      headings.push({ depth: block.depth, text: headingText(block) });
      openHeadings = headings.map(({ text }) => text);
      openHeadingsCost = openHeadings.reduce((sum, text) => sum + text.length + 1, 0);
      headingBudget = sectionBudget;
    }
    const text = visibleText(block);
    if (text.trim() !== '') place(String(index), text);
  });
  close();
  return chunks;
}
