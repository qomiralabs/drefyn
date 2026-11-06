import type { MdxRoot } from './types.ts';

export interface ReaderOptions {
  // The same registry a page renders with. Any other element renders as nothing.
  readonly components: ReadonlySet<string>;
}

const VALUE_NODES: ReadonlySet<string> = new Set(['text', 'inlineCode', 'code']);
const ALT_NODES: ReadonlySet<string> = new Set(['image', 'imageReference']);

// Each node a reader sees the children of, and what goes between them. A list and not a filter:
// a node type added later stays out until someone decides a reader sees it.
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

const VOID_TAGS: ReadonlySet<string> = new Set(
  'area base br col embed hr img input link meta param source track wbr'.split(' '),
);

// The HTML parser takes only their own close tag, whatever looks like a tag inside.
const RAW_TEXT_TAGS: ReadonlySet<string> = new Set(
  'iframe noembed noframes noscript script style textarea title xmp'.split(' '),
);

// Close tags of anything outside these do not reach them. Also what the sanitizer strips whole.
const STICKY_TAGS: ReadonlySet<string> = new Set([
  ...RAW_TEXT_TAGS,
  ...'math object plaintext svg template'.split(' '),
]);

const NEVER_CLOSED = 'plaintext';

interface OpenTag {
  readonly name: string;
  readonly parent: unknown;
}

// Tracks raw HTML across a page's nodes, as the parser does when it stitches them together, so
// that a tag and its close in different blocks still hide what lies between. Every doubt goes the
// same way: it hides. Text that renders may go unsearched, but a chunk never holds what a reader
// does not get. So all raw HTML content stays out, even under a tag the sanitizer would keep.
class RawHtml {
  private readonly open: OpenTag[] = [];

  get hiding(): boolean {
    return this.open.length > 0;
  }

  private giveUp(): number {
    this.open.push({ name: NEVER_CLOSED, parent: null });
    return Infinity;
  }

  // Past the end of a tag, or Infinity for one the node never finishes, as it then runs on.
  private endOfTag(value: string, from: number): number {
    let quote = '';
    for (let at = from; at < value.length; at += 1) {
      const char = value.charAt(at);
      if (quote !== '') {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '>') return at + 1;
    }
    return Infinity;
  }

  // A close in another parent does not reach the tag: a block between them is inside the element
  // by then, and the close lands in that block.
  private close(name: string, parent: unknown): void {
    const top = this.open.at(-1);
    if (top === undefined || (STICKY_TAGS.has(top.name) && top.name !== name)) return;
    const at = this.open.findLastIndex((tag) => tag.name === name && tag.parent === parent);
    if (at >= 0) this.open.length = at;
  }

  private skipRawText(
    value: string,
    from: number,
    { name, parent }: OpenTag,
    here: unknown,
  ): number {
    if (name === NEVER_CLOSED || parent !== here) return Infinity;
    const lower = value.toLowerCase();
    for (
      let at = lower.indexOf(`</${name}`, from);
      at >= 0;
      at = lower.indexOf(`</${name}`, at + 1)
    ) {
      const after = at + name.length + 2;
      if (!/[a-z0-9-]/i.test(lower.charAt(after))) {
        this.open.pop();
        const end = lower.indexOf('>', after);
        return end < 0 ? this.giveUp() : end + 1;
      }
    }
    return Infinity;
  }

  private readTag(value: string, from: number, parent: unknown): number {
    const isClose = value.charAt(from + 1) === '/';
    const nameAt = from + (isClose ? 2 : 1);
    let nameEnd = nameAt;
    while (/[^\s/>]/.test(value.charAt(nameEnd))) nameEnd += 1;
    const name = value.slice(nameAt, nameEnd).toLowerCase();
    const end = this.endOfTag(value, nameEnd);
    if (end === Infinity) return this.giveUp();
    if (isClose) this.close(name, parent);
    else if (!VOID_TAGS.has(name)) this.open.push({ name, parent });
    return end;
  }

  private readDeclaration(value: string, from: number): number {
    const isComment = value.startsWith('<!--', from);
    const end = isComment ? value.indexOf('-->', from + 4) : value.indexOf('>', from);
    if (end < 0) return this.giveUp();
    return end + (isComment ? 3 : 1);
  }

  read(value: string, parent: unknown): void {
    let at = 0;
    while (at < value.length) {
      const top = this.open.at(-1);
      if (top !== undefined && (RAW_TEXT_TAGS.has(top.name) || top.name === NEVER_CLOSED)) {
        at = this.skipRawText(value, at, top, parent);
        continue;
      }
      const start = value.indexOf('<', at);
      if (start < 0) return;
      const next = value.charAt(start + 1);
      if (next === '!' || next === '?') at = this.readDeclaration(value, start);
      else if (next === '/' || /[a-z]/i.test(next)) at = this.readTag(value, start, parent);
      else at = start + 1;
    }
  }
}

interface Walked {
  readonly type?: unknown;
  readonly value?: unknown;
  readonly alt?: unknown;
  readonly name?: unknown;
  readonly identifier?: unknown;
  readonly align?: unknown;
  readonly children?: unknown;
}

interface Frame {
  readonly node: Walked;
  readonly parent: unknown;
}

interface Walk {
  readonly html: RawHtml;
  readonly components: ReadonlySet<string>;
  // Whether to go into a footnote where it sits in the source.
  readonly definition: (node: Walked) => boolean;
  readonly reference: (id: string) => void;
}

const idOf = ({ identifier }: Walked) => String(identifier).toUpperCase();

const childrenOf = ({ type, children, align }: Walked): readonly unknown[] => {
  if (!Array.isArray(children)) return [];
  if (type !== 'table' || !Array.isArray(align)) return children as unknown[];
  // Cells past the header render as nothing, though the parser keeps them.
  return (children as Walked[]).map((row) => ({
    ...row,
    children: Array.isArray(row.children) ? row.children.slice(0, align.length) : [],
  }));
};

function opens(node: Walked, { components, definition }: Walk): boolean {
  const { type, name } = node;
  if (type === 'mdxJsxFlowElement' || type === 'mdxJsxTextElement') {
    return typeof name === 'string' && components.has(name);
  }
  return type === 'footnoteDefinition' ? definition(node) : true;
}

// Keeps its own stack, as a rollback reads a tree nothing has walked in this process. Separators
// sit on the stack with the nodes, so they come out in reading order.
function walk(start: Walked, parent: unknown, state: Walk): string {
  const { html, reference } = state;
  let text = '';
  const stack: (Frame | string)[] = [{ node: start, parent }];
  while (stack.length > 0) {
    const frame = stack.pop() ?? '';
    if (typeof frame === 'string') {
      text += frame;
      continue;
    }
    const { node } = frame;
    const type = String(node.type);
    const between = CONTAINERS.get(type);
    if (type === 'html' && typeof node.value === 'string') html.read(node.value, frame.parent);
    else if (type === 'footnoteReference' && !html.hiding) reference(idOf(node));
    else if (between !== undefined && opens(node, state)) {
      const children = childrenOf(node);
      for (let at = children.length - 1; at >= 0; at -= 1) {
        stack.push({ node: children[at] as Walked, parent: node });
        if (at > 0 && between !== '') stack.push(between);
      }
    } else if (html.hiding) continue;
    else if (VALUE_NODES.has(type) && typeof node.value === 'string') text += node.value;
    else if (ALT_NODES.has(type) && typeof node.alt === 'string') text += node.alt;
    else if (type === 'break') text += '\n';
  }
  return text;
}

// A footnote renders at the foot of the page, in order of reference, and only when something shown
// names it. A second definition of a name never renders. The foot sits after everything else, so
// a tag left open anywhere, or by one footnote, hides the rest of them.
function shownFootnotes(root: MdxRoot, components: ReadonlySet<string>): ReadonlySet<unknown> {
  const first = new Map<string, Walked>();
  const named = new Set<string>();
  const definition = (node: Walked) => {
    if (!first.has(idOf(node))) first.set(idOf(node), node);
    return false;
  };
  const reference = (id: string) => named.add(id);
  const html = new RawHtml();
  for (const block of root.children) walk(block, root, { html, components, definition, reference });
  if (html.hiding) return new Set();

  const shown = new Set<unknown>();
  for (const id of named) {
    const node = first.get(id);
    if (node === undefined) continue;
    const own = new RawHtml();
    for (const child of childrenOf(node)) {
      walk(child as Walked, node, { html: own, components, definition, reference });
    }
    if (own.hiding) return new Set();
    shown.add(node);
  }
  return shown;
}

// What a reader of this tree can get, a string for each top level block in order. Pure, and linear
// in the tree, so a save can afford it. It is the rule `renderSafe` applies, without an HTML parser:
// a page's text here is always part of what renders, and never more.
export function readerBlocks(root: MdxRoot, { components }: ReaderOptions): readonly string[] {
  const shown = shownFootnotes(root, components);
  const state: Walk = {
    html: new RawHtml(),
    components,
    definition: (node) => shown.has(node),
    reference: () => undefined,
  };
  return root.children.map((block) => walk(block, root, state));
}
