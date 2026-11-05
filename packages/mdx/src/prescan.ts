import type { MdxIssueCode, MdxLimits } from './types.ts';

// micromark, its resolvers and the GFM transforms go quadratic in the same way: each opener
// rescans the rest of its paragraph. Every opener is ASCII punctuation, so openers times
// paragraph length estimates the work without naming a construct. This pass is linear and
// refuses a page before the parser starts when that estimate is out of line. It is an
// estimate, so it makes refusals cheap and bounds nothing. Only the kill in `isolated.ts` does.

// The highest of 2,166 real pages is 60 million.
const MAX_WORK = 2 ** 28;
// Closing a container splices the page's event list, so markers times page size is the same
// estimate one level up, and blank lines do not help. The highest real page is 47 million;
// this leaves room for a 1 MiB changelog with 1,000 list items or a 100 KB page with 10,000.
const MAX_CONTAINER_WORK = 2 ** 30;
// Each setext underline splices the whole event list, so these add up across a page however
// the lines are spaced out. The highest real page has 68.
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
const PUNCTUATION = new Uint8Array(128);
for (const mark of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') PUNCTUATION[mark.charCodeAt(0)] = 1;
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

function linePrefix(text: string, lineStart: number, maxMarkers: number): number {
  let at = lineStart;
  let markers = 0;
  for (;;) {
    while (isSpace(text.charCodeAt(at))) at += 1;
    const next = markerEnd(text, at);
    if (next < 0 || markers > maxMarkers) return markers;
    markers += 1;
    at = next;
  }
}

export function prescan(
  text: string,
  { maxDepth }: Pick<MdxLimits, 'maxDepth'>,
): MdxIssueCode | undefined {
  let work = 0;
  let openers = 0;
  let runStart = 0;
  let underlines = 0;
  let containers = 0;
  let at = 0;
  while (at < text.length) {
    const lineStart = at;
    // No line in 2,166 real pages opens more than two levels, and each level multiplies the
    // cost of every line under it, so a long run of `>` is refused even in a code block.
    const markers = linePrefix(text, lineStart, maxDepth);
    if (markers > maxDepth) return 'mdx.too_deep';
    containers += markers;
    while (isSpace(text.charCodeAt(at))) at += 1;
    const first = text.charCodeAt(at);
    let underline = first === EQUALS || first === DASH;
    let blank = true;
    for (; at < text.length; at += 1) {
      const code = text.charCodeAt(at);
      if (code === LF || code === CR) break;
      if (isSpace(code)) continue;
      blank = false;
      underline &&= code === first;
      if (code < PUNCTUATION.length) openers += PUNCTUATION[code] ?? 0;
    }
    // A CRLF is one line ending; reading it as two would make every line look blank.
    at += text.charCodeAt(at) === CR && text.charCodeAt(at + 1) === LF ? 2 : 1;
    if (underline) underlines += 1;
    if (blank) {
      work += openers * (lineStart - runStart);
      openers = 0;
      runStart = at;
    }
    if (
      work + openers * (at - runStart) > MAX_WORK ||
      underlines > MAX_UNDERLINES ||
      containers * text.length > MAX_CONTAINER_WORK
    ) {
      return 'mdx.too_many_nodes';
    }
  }
  return undefined;
}
