import type { MdxIssueCode, MdxLimits } from './types.ts';

// micromark goes quadratic on some input, and limits checked on its result come too late: a
// 200 KB run of `a*` or `1. ` takes over 15 s. This pass is linear and refuses those shapes
// before the parser starts. It narrows the worst case and does not close it, so hostile input
// still has to meet the parse worker's timeout.

// A code block can hold a long run of `>` that is not nesting, so a line only fails on far
// more markers than the tree may nest. Nesting this shallow parses fast either way.
const MARKERS_PER_DEPTH = 4;
// The busiest paragraph in 2,166 real files had 535, so this is well clear of real pages.
const MAX_SYNTAX_PER_RUN = 2_048;
// Each setext underline splices the whole event list, so these add up across a page however
// the lines are spaced out.
const MAX_UNDERLINES = 1_024;

const TAB = 9;
const LF = 10;
const CR = 13;
const SPACE = 32;
const ZERO = 48;
const NINE = 57;
const DASH = 45;
const EQUALS = 61;

// A table, not a Set: this is read once per byte of every page.
const INLINE_SYNTAX = new Uint8Array(128);
for (const mark of '*_[]{}=') INLINE_SYNTAX[mark.charCodeAt(0)] = 1;
const BULLETS = new Set(['-', '+', '*'].map((c) => c.charCodeAt(0)));
const ORDERED_END = new Set(['.', ')'].map((c) => c.charCodeAt(0)));
const QUOTE = '>'.charCodeAt(0);

const isSpace = (code: number) => code === SPACE || code === TAB;

// Container markers open a nesting level each, however little they take up.
function markerEnd(text: string, at: number): number {
  const code = text.charCodeAt(at);
  if (code === QUOTE) return at + 1;
  if (BULLETS.has(code)) return isSpace(text.charCodeAt(at + 1)) ? at + 1 : -1;
  let end = at;
  while (text.charCodeAt(end) >= ZERO && text.charCodeAt(end) <= NINE) end += 1;
  if (end === at || !ORDERED_END.has(text.charCodeAt(end))) return -1;
  return isSpace(text.charCodeAt(end + 1)) ? end + 1 : -1;
}

function linePrefix(text: string, lineStart: number): { readonly markers: number; end: number } {
  let at = lineStart;
  let markers = 0;
  for (;;) {
    while (isSpace(text.charCodeAt(at))) at += 1;
    const next = markerEnd(text, at);
    if (next < 0) return { markers, end: at };
    markers += 1;
    at = next;
  }
}

export function prescan(
  text: string,
  { maxDepth }: Pick<MdxLimits, 'maxDepth'>,
): MdxIssueCode | undefined {
  const maxMarkers = maxDepth * MARKERS_PER_DEPTH;
  let syntax = 0;
  let underlines = 0;
  let at = 0;
  while (at < text.length) {
    const { markers, end } = linePrefix(text, at);
    if (markers > maxMarkers) return 'mdx.too_deep';
    const first = text.charCodeAt(end);
    let blank = markers === 0;
    let underline = first === EQUALS || first === DASH;
    for (at = end; at < text.length; at += 1) {
      const code = text.charCodeAt(at);
      if (code === LF || code === CR) break;
      if (!isSpace(code)) {
        blank = false;
        underline &&= code === first;
      }
      if (code < INLINE_SYNTAX.length) syntax += INLINE_SYNTAX[code] ?? 0;
    }
    // A CRLF is one line ending; reading it as two would make every line look blank.
    at += text.charCodeAt(at) === CR && text.charCodeAt(at + 1) === LF ? 2 : 1;
    if (blank) syntax = 0;
    if (underline) underlines += 1;
    if (syntax > MAX_SYNTAX_PER_RUN || underlines > MAX_UNDERLINES) return 'mdx.too_many_nodes';
  }
  return undefined;
}
