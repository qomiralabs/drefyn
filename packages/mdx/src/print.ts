import type { RootContent } from 'mdast';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';
import remarkStringify from 'remark-stringify';
import type { Options } from 'remark-stringify';
import { unified } from 'unified';
import { foldLineEndings } from './canonical.ts';
import type { Dialect, MdastBlock } from './types.ts';

const BOM = String.fromCharCode(0xfeff);

const ALWAYS_UNSAFE = [
  // A parser drops this at the very start of a file, where a block can land.
  { atBreak: true, character: BOM },
  // A reference followed by text starting with a colon reads as a definition at a line start.
  { before: '\\]', character: ':', inConstruct: 'phrasing' as const },
];

// A stored format. Changing any of this is an astVersion bump, and it never reprints stored
// blocks: they keep their bytes until someone edits them. Each is spelled out even where it is
// the library default, so a dependency bump cannot move it.
const CANONICAL: Options = {
  bullet: '-',
  // Stryker disable next-line StringLiteral: an empty option falls back to this same default
  bulletOrdered: '.',
  // Stryker disable next-line StringLiteral: same
  emphasis: '*',
  // Stryker disable next-line StringLiteral: same
  strong: '*',
  fences: true,
  rule: '-',
  // Stryker disable next-line StringLiteral: same
  listItemIndent: 'one',
  incrementListMarker: true,
  unsafe: ALWAYS_UNSAFE,
};

const MARKDOWN_NODES = [
  'blockquote',
  'break',
  'code',
  'definition',
  'delete',
  'emphasis',
  'footnoteDefinition',
  'footnoteReference',
  'heading',
  'image',
  'imageReference',
  'inlineCode',
  'link',
  'linkReference',
  'list',
  'listItem',
  'paragraph',
  'strong',
  'table',
  'tableCell',
  'tableRow',
  'text',
  'thematicBreak',
  'yaml',
];

// What the parser can hand back for each dialect, and so what can survive a trip through git.
const PRINTABLE: Readonly<Record<Dialect, ReadonlySet<string>>> = {
  md: new Set([...MARKDOWN_NODES, 'html']),
  mdx: new Set([
    ...MARKDOWN_NODES,
    'mdxFlowExpression',
    'mdxJsxFlowElement',
    'mdxJsxTextElement',
    'mdxTextExpression',
    'mdxjsEsm',
  ]),
};

export class MdxPrintError extends Error {
  readonly code = 'mdx.block_not_printable';
  readonly blockIndex: number;

  constructor(blockIndex = 0) {
    super(`mdx.block_not_printable: block ${blockIndex}`);
    this.name = 'MdxPrintError';
    this.blockIndex = blockIndex;
  }
}

interface Attribute {
  readonly type?: string;
  readonly value?: string | { readonly value?: unknown } | null;
}

interface Prepared {
  type: string;
  value?: unknown;
  attributes?: readonly Attribute[];
  align?: readonly (string | null)[] | null;
  children?: Prepared[];
  spread?: unknown;
  data?: { tight?: boolean; dedent?: string };
  [key: string]: unknown;
}

// Handlers write this in front of a line that the JSX printer is about to indent. Private use
// characters, picked per block, so no value can hold one and be mistaken for it.
const FIRST_MARK = 0xe000;
const LAST_MARK = 0xf8ff;

function pickMark(block: MdastBlock): string {
  const text = JSON.stringify(block);
  for (let code = FIRST_MARK; code <= LAST_MARK; code += 1) {
    const mark = String.fromCharCode(code);
    if (!text.includes(mark)) return mark;
  }
  throw new MdxPrintError();
}

// Stryker disable next-line StringLiteral: only has to match the handler key built from it
const JOINT = 'tightJoint';
// Stryker disable next-line StringLiteral: any label that is not a depth
const TIGHT = 't';

function foldAttribute(attribute: Attribute): Attribute {
  const { value } = attribute;
  if (typeof value === 'string') return { ...attribute, value: foldLineEndings(value) };
  if (typeof value?.value !== 'string') return attribute;
  return { ...attribute, value: { ...value, value: foldLineEndings(value.value) } };
}

// Spread on reparse only looks at blank lines the item itself can see, and a quote hides them.
function isTightInside(node: Prepared, tight: boolean): boolean {
  if (node.type === 'listItem') return node.spread === false;
  return node.type !== 'blockquote' && tight;
}

// At a line start, html can become a block of its own, so the stock printer swaps that line
// ending for a space. By then a heading has already picked two lines for its break, and on the
// next pass it has none. So in a heading the swap happens up front.
function spaceBeforeHtml(children: Prepared[]): Prepared[] {
  return children.map((child, index) => {
    if (child.type !== 'text' || children[index + 1]?.type !== 'html') return child;
    return { ...child, value: (child.value as string).replace(/\n$/, ' ') };
  });
}

// The printer has to put a blank line before these, or a rule would make a heading of the text
// and a definition would join it. That line makes the item spread on reparse, so it has to print
// spread from the first pass.
const needsBlankAfterText = ({ children = [] }: Prepared) =>
  children.some(
    ({ type }, index) =>
      (type === 'thematicBreak' || type === 'footnoteDefinition') &&
      children[index - 1]?.type === 'paragraph',
  );

// Only a footnote leaves its indent on a line of nothing but whitespace, so such a line in a code
// block grows on every pass. Lists, quotes and JSX strip theirs.
function blankCode(child: Prepared): Prepared {
  if (child.type !== 'code') return child;
  return { ...child, value: (child.value as string).replace(/^[ \t]+$/gm, '') };
}

function settleChildren(type: string, children: Prepared[]): Prepared[] {
  if (type === 'heading') return spaceBeforeHtml(children);
  return type === 'footnoteDefinition' ? children.map(blankCode) : children;
}

// A private copy: values lose their CRLF, which the printer would otherwise double, and the
// marks below go on this and not on the caller's tree.
function prepare(node: Prepared, dialect: Dialect, tight: boolean): Prepared {
  if (!PRINTABLE[dialect].has(node.type)) throw new MdxPrintError();
  const inTight = isTightInside(node, tight);
  const copy: Prepared = { ...node };
  // Marks live here, so nothing a caller put on a node can pose as one.
  delete copy.data;
  if (typeof node.value === 'string') copy.value = foldLineEndings(node.value);
  if (node.attributes !== undefined) copy.attributes = node.attributes.map(foldAttribute);
  if (node.children !== undefined) {
    const children = node.children.map((child) => prepare(child, dialect, inTight));
    copy.children = settleChildren(node.type, children);
  }
  if (node.type === 'mdxJsxFlowElement' && inTight) copy.data = { tight: true };
  if (node.type === 'listItem' && needsBlankAfterText(node)) copy.spread = true;
  return copy;
}

const indentAfterFirst = (value: string, prefix: string) =>
  value
    .split('\n')
    .map((line, index) => (index === 0 || line === '' ? line : `${prefix}${line}`))
    .join('\n');

// The stock printer writes attribute values as they are, and the parser eats two spaces from
// each line of an expression. A string is not an expression, so nothing is eaten there.
function markAttribute(attribute: Attribute, dedent: string): Attribute {
  const { type, value } = attribute;
  if (typeof value === 'string') {
    const prefix = type === 'mdxJsxExpressionAttribute' ? `${dedent}  ` : dedent;
    return { ...attribute, value: indentAfterFirst(value, prefix) };
  }
  if (typeof value?.value !== 'string') return attribute;
  return { ...attribute, value: { ...value, value: indentAfterFirst(value.value, `${dedent}  `) } };
}

function jsxDepthInside(type: string, depth: number): number {
  if (type === 'blockquote' || type === 'listItem') return 0;
  return type === 'mdxJsxFlowElement' ? depth + 1 : depth;
}

// JSX indents everything inside it by two spaces a level, but only containers change what the
// parser strips. So lines inside JSX are marked to lose that indent again after printing.
function setMarks(node: Prepared, mark: string, depth: number): void {
  const dedent = depth === 0 ? '' : `${mark}${String(depth)}${mark}`;
  if (node.type === 'mdxFlowExpression' || node.type === 'mdxjsEsm') {
    node.data = { dedent };
  }
  if (node.attributes !== undefined) {
    node.attributes = node.attributes.map((attribute) => markAttribute(attribute, dedent));
  }
  const inner = jsxDepthInside(node.type, depth);
  for (const child of node.children ?? []) setMarks(child, mark, inner);
  if (node.data?.tight === true && node.children !== undefined) {
    node.children = node.children.flatMap((child, index) =>
      index === 0 ? [child] : [{ type: JOINT, value: mark }, child],
    );
  }
}

interface PrintState {
  handle(node: unknown, parent: unknown, state: unknown, info: unknown): string;
  indentLines(value: string, map: (line: string, index: number, blank: boolean) => string): string;
}

const dedentOf = (node: Prepared) => (node.data as { dedent: string }).dedent;

// The parser eats a fixed two spaces per expression line, but JSX indents by two per depth, so
// the stock printer grows a deep value on every pass.
function flowExpression(node: Prepared, _parent: unknown, state: PrintState): string {
  const dedent = dedentOf(node);
  const body = state.indentLines(node.value as string, (line, index, blank) =>
    index === 0 || blank ? line : `${dedent}  ${line}`,
  );
  return `{${body}}`;
}

// ESM only exists at column one, so it can take no JSX indent at all. It also runs until a blank
// line, so inside JSX it needs one or it takes the closing tag with it.
function esm(node: Prepared): string {
  const dedent = dedentOf(node);
  const lines = (node.value as string).split('\n').map((line) => `${dedent}${line}`);
  return `${lines.join('\n')}${dedent === '' ? '' : '\n'}`;
}

const DELIMITERS: Readonly<Record<string, string>> = { left: ':-', right: '-:', center: ':-:' };

// The stock printer pads every row to the widest one, which adds cells the tree never had and
// makes a one word edit move every row.
function table(node: Prepared, _parent: unknown, state: PrintState, info: unknown): string {
  const rows = node.children ?? [];
  const lines = rows.map((row) => state.handle(row, node, state, info));
  const columns = rows[0]?.children?.length ?? 0;
  const delimiters = Array.from(
    { length: columns },
    (_, index) => DELIMITERS[node.align?.[index] ?? ''] ?? '-',
  );
  lines.splice(1, 0, `| ${delimiters.join(' | ')} |`);
  return lines.join('\n');
}

// A stand in between children, because the stock JSX printer always puts a blank line there,
// and one flips a tight list item to spread on reparse. It goes with the blank lines around it.
const tightJoint = (node: Prepared) => `${String(node.value)}${TIGHT}${String(node.value)}`;

function removeMarks(text: string, mark: string): string {
  let output = '';
  let at = 0;
  for (;;) {
    const open = text.indexOf(mark, at);
    if (open === -1) return output + text.slice(at);
    const close = text.indexOf(mark, open + 1);
    const label = text.slice(open + 1, close);
    const tight = label === TIGHT;
    const lowest = tight ? at : Math.max(at, open - 2 * Number(label));
    let keep = open;
    while (keep > lowest && text[keep - 1] === ' ') keep -= 1;
    output += text.slice(at, tight ? keep - 2 : keep);
    at = tight ? close + 2 : close + 1;
  }
}

// Text that starts a line this way would parse back as ESM, or fail the page if it is not ESM.
const ESM_LOOKALIKES = [
  { atBreak: true, character: 'i', after: 'mport ' },
  { atBreak: true, character: 'e', after: 'xport ' },
];

const stringifier = (dialect: Dialect, overrides: Options) => {
  const markdown = unified().use(remarkFrontmatter).use(remarkGfm);
  const handlers = { table, mdxFlowExpression: flowExpression, mdxjsEsm: esm, [JOINT]: tightJoint };
  const options = { ...CANONICAL, ...overrides, handlers } as unknown as Options;
  if (dialect === 'md') return markdown.use(remarkStringify, options).freeze();
  const unsafe = [...ALWAYS_UNSAFE, ...ESM_LOOKALIKES];
  return markdown
    .use(remarkMdx)
    .use(remarkStringify, { ...options, unsafe })
    .freeze();
};

type Stringifier = ReturnType<typeof stringifier>;

// The few settings a block may print under when its neighbours rule out the canonical one.
export type Override = Pick<Options, 'bullet' | 'bulletOrdered' | 'rule'>;

const printers = new Map<string, Stringifier>();

function printerFor(dialect: Dialect, overrides: Override): Stringifier {
  const key = `${dialect}${JSON.stringify(overrides)}`;
  const printer = printers.get(key) ?? stringifier(dialect, overrides);
  // Stryker disable next-line all: a cache, so losing an entry only builds the printer again
  printers.set(key, printer);
  return printer;
}

const CLOSING_FENCE = /^---[ \t]*$/m;

export function printWith(block: MdastBlock, dialect: Dialect, overrides: Override): string {
  try {
    const copy = prepare(block as unknown as Prepared, dialect, false);
    if (copy.type === 'yaml' && CLOSING_FENCE.test(copy.value as string)) {
      throw new MdxPrintError();
    }
    const mark = pickMark(block);
    setMarks(copy, mark, 0);
    const text = printerFor(dialect, overrides).stringify({
      type: 'root',
      children: [copy as unknown as RootContent],
    });
    return removeMarks(text.replace(/\n$/, ''), mark);
  } catch {
    // Unknown kinds, and trees deep enough to run out of stack. The cause can quote content.
    throw new MdxPrintError();
  }
}

// Pure, and always LF: the file's own line ending goes on where the block lands in a file.
export const printCanonical = (block: MdastBlock, dialect: Dialect): string =>
  printWith(block, dialect, {});
