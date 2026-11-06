import type { Element, Nodes } from 'hast';
import { raw } from 'hast-util-raw';
import { sanitize } from 'hast-util-sanitize';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import type { Jsx } from 'hast-util-to-jsx-runtime';
import type { List, ListItem, Nodes as MdastNodes, Root as MdastRoot } from 'mdast';
import { defaultHandlers, toHast } from 'mdast-util-to-hast';
import type { Handler } from 'mdast-util-to-hast';
import type { ReactElement } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { CEILING, policySchema } from './policy.ts';
import { CLOBBER_PREFIX, schemaFor } from './sanitize-schema.ts';
import { validateTree } from './tree-check.ts';
import type { MdxRoot, RenderPolicy } from './types.ts';

export type RenderRefusedCode =
  | 'render.invalid_policy'
  | 'render.invalid_tree'
  | 'render.too_deep'
  | 'render.too_complex'
  | 'render.failed';

// The page does not publish, and the last good one stays. The message is the code alone, so
// this can reach a log with no customer text in it.
export class RenderRefused extends Error {
  readonly code: RenderRefusedCode;

  constructor(code: RenderRefusedCode) {
    super(code);
    this.name = 'RenderRefused';
    this.code = code;
  }
}

// This runs in the caller's process, with no thread to kill. The HTML parser is quadratic in
// open elements, in formatting elements and in the attributes of one tag, so each is bounded
// first. Every count below is an upper bound whatever state the parser is in: a comment or a
// quoted value can only make them higher.
const MAX_RAW_TAGS = 5_000;
const MAX_RAW_ATTRIBUTES = 10_000;
// Each block reopens every formatting element left open, so a page can ask for the product.
const MAX_REOPENED = 500_000;

// The Markdown conversion searches a list of all footnotes for each reference, and all the items
// of a list for each item. No thread can stop it either.
const MAX_FOOTNOTES = 2_000;
const MAX_LIST_ITEMS = 5_000;

const TAG = /<\/?[a-z]/gi;
const ATTRIBUTE = /[\s/"'][^\s/"'>]/g;
const FORMATTING = /<(?:a|b|big|code|em|font|i|nobr|s|small|strike|strong|tt|u)(?=[\s/>]|$)/gi;

// A footnote section sits a few levels above what the tree counts.
const DEPTH_SLACK = 8;

// Both, because https:a.example is the page's own path on an https page and a remote host on
// an http one.
const LOCAL_BASES = ['https://page.invalid/', 'http://page.invalid/'];

const CLOBBERED = ['id', 'name', 'ariaDescribedBy', 'ariaLabelledBy'] as const;
const PREFIXED = new RegExp(`^(?:${CLOBBER_PREFIX})+`);
const LINE_BREAK = /\r\n?/g;

type JsxElement = Extract<MdastNodes, { type: 'mdxJsxFlowElement' | 'mdxJsxTextElement' }>;

const nothing: Handler = () => undefined;

const count = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].length;

function censusOf(tree: Nodes): { elements: number; raw: string[] } {
  const census = { elements: 0, raw: [] as string[] };
  const pending: Nodes[] = [tree];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.type === 'element') census.elements += 1;
    if (node.type === 'raw') census.raw.push(node.value);
    if ('children' in node) pending.push(...node.children);
  }
  return census;
}

function holdConversion(root: MdxRoot): void {
  let footnotes = 0;
  const pending: MdastNodes[] = [...root.children];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.type === 'footnoteReference') footnotes += 1;
    if (node.type === 'list' && node.children.length > MAX_LIST_ITEMS) {
      throw new RenderRefused('render.too_complex');
    }
    if ('children' in node) pending.push(...node.children);
  }
  if (footnotes > MAX_FOOTNOTES) throw new RenderRefused('render.too_complex');
}

function holdRawBudget(rawHtml: string, elements: number): void {
  const tags = count(rawHtml, TAG);
  if (
    tags > MAX_RAW_TAGS ||
    count(rawHtml, ATTRIBUTE) > MAX_RAW_ATTRIBUTES ||
    count(rawHtml, FORMATTING) * (tags + elements) > MAX_REOPENED
  ) {
    throw new RenderRefused('render.too_complex');
  }
}

function isLocal(url: string): boolean {
  try {
    return LOCAL_BASES.every((base) => new URL(url, base).origin === new URL(base).origin);
  } catch {
    return false;
  }
}

const unprefixed = (value: unknown) =>
  typeof value === 'string' ? value.replace(PREFIXED, '') : value;

// The sanitizer always prefixes, so what arrives prefixed loses it here and a second render
// says the same as the first.
function unprefix(properties: Record<string, unknown>): void {
  for (const key of CLOBBERED) {
    const value = properties[key];
    if (value === undefined) continue;
    properties[key] = Array.isArray(value) ? value.map(unprefixed) : unprefixed(value);
  }
}

// A browser reads every line break as a line feed, and a second render would too.
function normalizeBreaks(properties: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value === 'string') properties[key] = value.replace(LINE_BREAK, '\n');
  }
}

function holdImage(properties: Record<string, unknown>, policy: RenderPolicy): void {
  const { src } = properties;
  if (typeof src !== 'string') return;
  // proxy has no signer to go through yet, so it holds images back as block does.
  const held = src === '' || (policy.remoteImages !== 'allow' && !isLocal(src));
  if (held) delete properties['src'];
  // React's server render preloads an image through a link element of its own, outside this
  // tree, unless the image is lazy.
  else properties['loading'] = 'lazy';
}

// A browser eats the first line feed in a pre. React writes an extra one to cover that, but only
// for a pre holding nothing but text, so anywhere else the line feed would go on a second read.
function settlePre(node: Element): void {
  const [first] = node.children;
  if (node.children.length > 1 && first?.type === 'text') {
    first.value = first.value.replace(/^\n+/, '');
  }
}

// Walks with its own stack, since a tree this has not measured may overflow one.
function prepare(tree: Nodes, policy: RenderPolicy): void {
  const maxDepth = policy.limits.maxDepth + DEPTH_SLACK;
  const pending: { node: Nodes; depth: number }[] = [{ node: tree, depth: 0 }];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const { node, depth } = at;
    if (depth > maxDepth) throw new RenderRefused('render.too_deep');
    if (node.type === 'text') node.value = node.value.replace(LINE_BREAK, '\n');
    if (node.type === 'element') {
      unprefix(node.properties);
      normalizeBreaks(node.properties);
      if (node.tagName === 'img') holdImage(node.properties, policy);
      if (node.tagName === 'pre') settlePre(node);
    }
    if ('children' in node) {
      for (const child of node.children) {
        pending.push({ node: child, depth: depth + 1 });
      }
    }
  }
}

const isLooseItem = ({ spread, children }: ListItem) => spread ?? children.length > 1;

// The library scans every item of a list for each item it converts, which is quadratic in a page
// the author controls. The answer is the same for all of them, so it gets the answer once, as a
// list with no items to scan. The output does not change.
function listItemOnce(): Handler {
  const answered = new Map<List, List>();
  return (state, node: ListItem, parent) => {
    if (parent?.type !== 'list') return defaultHandlers.listItem(state, node, parent);
    let summary = answered.get(parent);
    if (summary === undefined) {
      const spread = Boolean(parent.spread) || parent.children.some(isLooseItem);
      summary = { type: 'list', spread, children: [] };
      answered.set(parent, summary);
    }
    return defaultHandlers.listItem(state, node, summary);
  };
}

function toHastTree(root: MdxRoot, policy: RenderPolicy): Nodes {
  // Props are dropped whatever they hold, so no expression is ever read, let alone run. Only
  // the name decides, and a name outside the registry takes its children with it.
  const element: Handler = (state, node: JsxElement) =>
    typeof node.name === 'string' && policy.components.has(node.name) ? state.all(node) : undefined;
  return toHast(root as unknown as MdastRoot, {
    allowDangerousHtml: policy.rawHtml === 'sanitize',
    handlers: {
      listItem: listItemOnce(),
      mdxFlowExpression: nothing,
      mdxJsxFlowElement: element,
      mdxJsxTextElement: element,
      mdxTextExpression: nothing,
      mdxjsEsm: nothing,
    },
    unknownHandler: nothing,
  });
}

function clean(tree: Nodes, policy: RenderPolicy): Nodes {
  prepare(tree, policy);
  return sanitize(tree, schemaFor(policy));
}

function transform(root: MdxRoot, policy: RenderPolicy): ReactElement {
  holdConversion(root);
  let tree = toHastTree(root, policy);
  const census = censusOf(tree);
  if (census.raw.length > 0) {
    holdRawBudget(census.raw.join(''), census.elements);
    // Unwrapping a tag the list refuses can leave a paragraph inside a paragraph, which a browser
    // would rebuild. A second parse settles the tree before the sanitizer has the last word.
    tree = raw(clean(raw(tree), policy));
  }
  // Nothing may follow this but the conversion to elements. In particular that conversion's
  // own table cell option would add back a style attribute.
  return toJsxRuntime(clean(tree, policy), {
    Fragment,
    jsx: jsx as Jsx,
    jsxs: jsxs as Jsx,
    tableCellAlignToStyle: false,
  }) as ReactElement;
}

// The only function that turns customer content into output. It takes a stored tree and trusts
// none of it: the shape is checked here too, because hostile pages run on the host that made
// it, and the stored form is many times its source, so maxBytes here is the ceiling of a tree
// and not the policy's limit on source. It throws RenderRefused, and never renders in part.
export function renderSafe(ast: MdxRoot, policy: RenderPolicy): ReactElement {
  const checked = policySchema.safeParse(policy);
  if (!checked.success) throw new RenderRefused('render.invalid_policy');
  const limits = { ...checked.data.limits, maxBytes: CEILING.maxBytes };
  const tree = validateTree(ast, limits);
  if (!tree.ok) throw new RenderRefused('render.invalid_tree');
  try {
    return transform(tree.value, policy);
  } catch (error) {
    if (error instanceof RenderRefused) throw error;
    // The libraries below recurse, and the HTML parser has crashed on stitched raw nodes. What
    // they say is not kept, as it can quote the page.
    throw new RenderRefused('render.failed');
  }
}
