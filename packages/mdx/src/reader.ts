import type { Nodes } from 'hast';
import { safeHast } from './render-safe.ts';
import type { MdxRoot, ReaderPage, ReaderUnit, RenderPolicy } from './types.ts';

const HEADING = /^h([1-6])$/;

// Elements a browser lays out on their own line. Without a break between them, the last word of
// one cell or item would join the first of the next into a word nobody wrote.
const BLOCK: ReadonlySet<string> = new Set(
  (
    'address article aside blockquote dd details div dl dt figcaption figure footer h1 h2 h3 h4 ' +
    'h5 h6 header hr li main nav ol p pre section summary table tbody tfoot thead tr ul'
  ).split(' '),
);
const CELL: ReadonlySet<string> = new Set(['td', 'th']);

const EDGE_BREAKS = /^\n+|\n+$/g;

type Piece = Nodes | '\n';

// Text nodes only: attributes, alt text and link targets stay out, as doubt hides. Keeps its own
// stack, since a tree the depth check passed can still be deep for recursion.
function textOf(node: Nodes): string {
  let text = '';
  const breakLine = () => {
    if (text !== '' && !text.endsWith('\n')) text += '\n';
  };
  const breakCell = () => {
    if (text !== '' && !text.endsWith('\n') && !text.endsWith('\t')) text += '\t';
  };
  const pending: Piece[] = [node];
  for (let piece = pending.pop(); piece !== undefined; piece = pending.pop()) {
    if (piece === '\n') breakLine();
    else if (piece.type === 'text') text += piece.value;
    else if (piece.type === 'element' && piece.tagName === 'br') text += '\n';
    else if ('children' in piece) {
      const tag = piece.type === 'element' ? piece.tagName : '';
      if (BLOCK.has(tag)) {
        breakLine();
        pending.push('\n');
      } else if (CELL.has(tag)) {
        breakCell();
      }
      for (let at = piece.children.length - 1; at >= 0; at -= 1) {
        const child = piece.children[at];
        if (child !== undefined) pending.push(child);
      }
    }
  }
  return text.replace(EDGE_BREAKS, '');
}

function unitsOf(tree: Nodes): readonly ReaderUnit[] {
  const top = tree.type === 'root' ? tree.children : [tree];
  const units: ReaderUnit[] = [];
  for (const node of top) {
    const text = textOf(node);
    const depth = node.type === 'element' ? HEADING.exec(node.tagName)?.[1] : undefined;
    if (depth !== undefined) units.push({ heading: { depth: Number(depth), text }, text });
    // Every element keeps its place even with no text, so a word added to an empty paragraph
    // cannot renumber the units after it. Line breaks between elements are layout, not units.
    else if (node.type === 'element' || text.trim() !== '') units.push({ text });
  }
  return units;
}

// What a reader of this page gets, as plain text in top level units, from the sanitized tree of
// the render itself. A second model of what is visible would disagree with the render somewhere,
// and chunks go on to search, the assistant and MCP. A page the render refuses has no text: it
// cannot publish either, so nothing a reader sees goes missing. Any failure counts as a refusal,
// as doubt hides.
export function readerPage(ast: MdxRoot, policy: RenderPolicy): ReaderPage {
  try {
    return { state: 'ok', units: unitsOf(safeHast(ast, policy)) };
  } catch {
    return { state: 'not_renderable' };
  }
}
