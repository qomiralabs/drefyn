import type { Schema } from 'hast-util-sanitize';
import type { RenderPolicy } from './types.ts';

export const CLOBBER_PREFIX = 'user-content-';

// A protocol list with nothing in it means "any" to the sanitizer. No real URL has this scheme,
// so an empty list stays what it says.
const NO_SCHEME = 'drefyn-none';

// Written out and not spread from the library's default, so an upgrade cannot widen what
// customer content may say. Everything outside these lists goes.
const TAG_NAMES = [
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'code',
  'dd',
  'del',
  'details',
  'div',
  'dl',
  'dt',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'input',
  'ins',
  'kbd',
  'li',
  'mark',
  'ol',
  'p',
  'pre',
  'q',
  's',
  'samp',
  'section',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'tt',
  'ul',
  'var',
];

// Unwrapping these would print their source as text, or keep a subtree meant for another parser.
const STRIP = [
  'iframe',
  'math',
  'noembed',
  'noframes',
  'noscript',
  'object',
  'plaintext',
  'script',
  'style',
  'svg',
  'template',
  'textarea',
  'title',
  'xmp',
];

const CELL = ['align', 'colSpan', 'rowSpan', 'scope'];
const ID_LISTS = ['ariaDescribedBy', 'ariaLabelledBy'];

const ATTRIBUTES: NonNullable<Schema['attributes']> = {
  '*': ['align', 'ariaHidden', 'ariaLabel', 'dir', 'id', 'lang', 'title'],
  a: [
    ...ID_LISTS,
    'href',
    'name',
    'dataFootnoteBackref',
    'dataFootnoteRef',
    ['className', 'data-footnote-backref'],
  ],
  code: [['className', /^language-[\w+#.-]+$/]],
  details: ['open'],
  h2: [['className', 'sr-only']],
  img: ['alt', 'height', 'src', 'width', ['loading', 'lazy']],
  input: ['checked', ['disabled', true], ['type', 'checkbox']],
  li: ['value', ['className', 'task-list-item']],
  ol: ['reversed', 'start', ['className', 'contains-task-list']],
  section: ['dataFootnotes', ['className', 'footnotes']],
  td: CELL,
  th: CELL,
  ul: [['className', 'contains-task-list']],
};

const schemes = (allowed: readonly string[]): string[] =>
  allowed.length === 0 ? [NO_SCHEME] : [...allowed];

export const schemaFor = (policy: RenderPolicy): Schema => ({
  allowComments: false,
  allowDoctypes: false,
  attributes: ATTRIBUTES,
  clobber: ['ariaDescribedBy', 'ariaLabelledBy', 'id', 'name'],
  clobberPrefix: CLOBBER_PREFIX,
  // An image has no use for a mail link, whatever links may hold.
  protocols: { href: schemes(policy.linkProtocols), src: ['http', 'https'] },
  required: { input: { disabled: true, type: 'checkbox' } },
  strip: STRIP,
  tagNames: TAG_NAMES,
});
