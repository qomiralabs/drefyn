import { parseFragment } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderSafe } from '../src/render.ts';
import type { Dialect, MdxBlock, MdxRoot, RenderPolicy } from '../src/index.ts';
import { sha256, parsed, policy } from './helpers.ts';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

const EMPTY_HASH = sha256(Buffer.alloc(0));

export const toHtml = (root: MdxRoot, use: RenderPolicy = policy()): string =>
  renderToStaticMarkup(createElement('div', null, renderSafe(root, use))).slice(5, -6);

export const rootOf = (children: readonly unknown[], dialect: Dialect = 'md'): MdxRoot => ({
  type: 'root',
  astVersion: 1,
  dialect,
  eol: 'lf',
  children: children as readonly MdxBlock[],
  tail: '',
  tailOf: EMPTY_HASH,
});

export const rendered = (source: string, dialect: Dialect = 'md', use = policy()): string =>
  toHtml(parsed(source, dialect, use), use);

// What a second render sees: the first one's output, read back as raw HTML.
export const rerendered = (html: string, use = policy()): string =>
  toHtml(rootOf([{ type: 'html', value: html }]), use);

const OUTPUT_TAGS = new Set(
  (
    'a abbr b blockquote br code dd del details div dl dt em h1 h2 h3 h4 h5 h6 hr i img input ins ' +
    'kbd li mark ol p pre q s samp section small span strike strong sub summary sup table tbody ' +
    'td tfoot th thead tr tt ul var'
  ).split(' '),
);
const OUTPUT_ATTRIBUTES = new Set(
  (
    'align alt aria-describedby aria-hidden aria-label aria-labelledby checked class colspan ' +
    'data-footnote-backref data-footnote-ref data-footnotes dir disabled height href id lang ' +
    'loading name open reversed rowspan scope src start title type value width'
  ).split(' '),
);
const BASE = 'https://page.invalid/';

function urlProblem(name: string, value: string, schemes: readonly string[]): string | undefined {
  if (name !== 'href' && name !== 'src') return undefined;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value, BASE);
  } catch {
    // No browser can follow this.
    return undefined;
  }
  const scheme = parsedUrl.protocol.slice(0, -1);
  return schemes.includes(scheme) ? undefined : `${name} has scheme ${scheme}`;
}

const isElement = (node: Node): node is Element => 'tagName' in node;

function problemsOf(node: Element, schemes: readonly string[]): string[] {
  const problems: string[] = [];
  if (!node.namespaceURI.endsWith('/xhtml')) problems.push(`${node.tagName} is not plain HTML`);
  if (!OUTPUT_TAGS.has(node.tagName)) problems.push(`element ${node.tagName}`);
  for (const { name, value } of node.attrs) {
    if (!OUTPUT_ATTRIBUTES.has(name)) problems.push(`attribute ${name} on ${node.tagName}`);
    const url = urlProblem(name, value, schemes);
    if (url !== undefined) problems.push(url);
    if ((name === 'id' || name === 'name') && !value.startsWith('user-content-')) {
      problems.push(`${name} is not prefixed`);
    }
  }
  return problems;
}

// Reads output with a parser of its own, as a browser would, so this cannot share a mistake
// with the code under test. Regular expressions on the string would pass on what a browser
// builds differently.
export function dangerIn(
  html: string,
  schemes: readonly string[] = ['https', 'http', 'mailto'],
): readonly string[] {
  const problems: string[] = [];
  const pending: Node[] = [parseFragment(html)];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isElement(node)) problems.push(...problemsOf(node, schemes));
    if ('childNodes' in node) pending.push(...node.childNodes);
  }
  return problems;
}
