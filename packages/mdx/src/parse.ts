import type { Root } from 'mdast';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { acornBudget } from './acorn-budget.ts';
import { rawOf } from './canonical.ts';
import { inspect, issue, LOOKS_LIKE_COMPONENT } from './inspect.ts';
import { parseInputSchema } from './policy.ts';
import { prescan } from './prescan.ts';
import { AST_VERSION } from './types.ts';
import type { Dialect, MdxBlock, MdxIssue, MdxRoot, ParseResult, RenderPolicy } from './types.ts';

const BOM = String.fromCharCode(0xfeff);
const SPACE = 32;
const TAB = 9;
const LF = 10;
const CR = 13;

const markdown = () => unified().use(remarkParse).use(remarkFrontmatter, ['yaml']).use(remarkGfm);
const markdownParser = markdown().freeze();
const refused = (issues: readonly MdxIssue[]): ParseResult => ({ ok: false, error: issues });

// The unclosed tag error only has its place in the message, as "(3:1-3:7)" at the end.
const PLACE_IN_MESSAGE = /\((\d+):(\d+)-\d+:\d+\)$/;

function placeOf(error: unknown): MdxIssue {
  // Deep input can run the parser or acorn out of stack, which is the depth limit by another
  // route. The error's message quotes the source, so only its place is kept.
  if (error instanceof RangeError) return issue('mdx.too_deep', 'error');
  const { line, column, message } = error as {
    line?: unknown;
    column?: unknown;
    message?: unknown;
  };
  if (typeof line === 'number' && typeof column === 'number') {
    return issue('mdx.parse_failed', 'error', line, column);
  }
  const place = typeof message === 'string' ? PLACE_IN_MESSAGE.exec(message) : null;
  return issue('mdx.parse_failed', 'error', Number(place?.[1] ?? 1), Number(place?.[2] ?? 1));
}

// The usual reason a page fails as MDX is that it is Markdown with loose HTML in it.
function failedOnHtml(text: string): boolean {
  try {
    return markdownParser
      .parse(text)
      .children.some((node) => node.type === 'html' && !LOOKS_LIKE_COMPONENT.test(node.value));
  } catch {
    return false;
  }
}

function lineEnding(text: string): MdxRoot['eol'] {
  let crlf = 0;
  let lf = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== LF) continue;
    if (index > 0 && text.charCodeAt(index - 1) === CR) crlf += 1;
    else lf += 1;
  }
  return crlf > lf ? 'crlf' : 'lf';
}

interface Span {
  readonly start: number;
  readonly end: number;
}

interface Slices {
  readonly children: readonly MdxBlock[];
  readonly tail: string;
}

// The BOM goes back in by hand: the parser skips one without counting it, so its offsets
// are only true for text that has none.
function slice(tree: Root, spans: readonly Span[], text: string, bom: string): Slices | undefined {
  const children: MdxBlock[] = [];
  let at = 0;
  for (const [index, node] of tree.children.entries()) {
    const span = spans[index];
    if (span === undefined) return undefined;
    let { start } = span;
    const { end } = span;
    if (start < at || end < start) return undefined;
    // Indent belongs to the block, or a reprint would leave it behind in the gap.
    while (start > at) {
      const before = text.charCodeAt(start - 1);
      if (before !== SPACE && before !== TAB) break;
      start -= 1;
    }
    const gapBefore = (at === 0 ? bom : '') + text.slice(at, start);
    const source = { raw: text.slice(start, end), gapBefore, rawOf: rawOf(node) };
    children.push({ ...node, source });
    at = end;
  }
  return { children, tail: (children.length === 0 ? bom : '') + text.slice(at) };
}

export function parseForStore(source: string, dialect: Dialect, policy: RenderPolicy): ParseResult {
  // A bad policy or dialect is our bug, not bad content, so it throws instead of returning.
  parseInputSchema.parse({ source, dialect, policy });
  if (Buffer.byteLength(source, 'utf8') > policy.limits.maxBytes) {
    return refused([issue('mdx.too_large', 'error')]);
  }

  const bom = source.startsWith(BOM) ? BOM : '';
  const text = source.slice(bom.length);
  const shape = prescan(text, policy.limits);
  if (shape !== undefined) return refused([issue(shape, 'error')]);

  let tree: Root;
  let spans: readonly Span[];
  let issues: readonly MdxIssue[];
  const budget = acornBudget(text.length);
  try {
    // A parser per call for MDX, so a budget can never leak from one page into the next.
    tree =
      dialect === 'mdx'
        ? markdown().use(remarkMdx, { acorn: budget.acorn }).parse(text)
        : markdownParser.parse(text);
    // Inspecting strips positions, and these are the only ones still needed.
    spans = tree.children.map(({ position }) => ({
      start: position?.start.offset ?? -1,
      end: position?.end.offset ?? -1,
    }));
    issues = inspect(tree, dialect, policy);
  } catch (error) {
    if (budget.exhausted()) return refused([issue('mdx.too_many_nodes', 'error')]);
    const place = placeOf(error);
    const hint =
      dialect === 'mdx' && place.code === 'mdx.parse_failed' && failedOnHtml(text)
        ? [issue('mdx.dialect_mismatch', 'warning', place.line, place.column)]
        : [];
    return refused([place, ...hint]);
  }
  if (issues.some(({ severity }) => severity === 'error')) return refused(issues);

  const slices = slice(tree, spans, text, bom);
  if (slices === undefined) return refused([issue('mdx.parse_failed', 'error')]);
  const ast: MdxRoot = {
    type: 'root',
    astVersion: AST_VERSION,
    dialect,
    eol: lineEnding(text),
    children: slices.children,
    tail: slices.tail,
  };
  return { ok: true, value: { ast, issues } };
}
