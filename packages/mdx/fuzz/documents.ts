import fc from 'fast-check';
import type { Dialect } from '../src/index.ts';

// Pieces that open and close block structure, so the generator reaches the parser's edges
// far more often than random text would.
const BOM = String.fromCharCode(0xfeff);
const NBSP = String.fromCharCode(0xa0);
const LINE_SEPARATOR = String.fromCharCode(0x2028);

const FRAGMENTS = [
  '# Title\n',
  'Setext\n===\n',
  'text',
  '*a*',
  '**b**',
  '`c`',
  '~~d~~',
  '[e](http://f.g)',
  '- item\n',
  '  - nested\n',
  '1. one\n',
  '* star\n',
  '> quote\n',
  '> > deep\n',
  '- [ ] task\n',
  '```js\ncode\n',
  '```\n',
  '~~~\n',
  '    indented\n',
  '---\n',
  'title: x\n',
  '***\n',
  '| a | b |\n',
  '|---|---|\n',
  '| c | d |\n',
  '[x]: http://a\n',
  '[x]\n',
  '[^1]: note\n',
  '[^1]\n',
  '<Note a="1">\n',
  '</Note>\n',
  '<br/>',
  '<>',
  '</>',
  '<A b={c} {...d}>',
  '</A>',
  '<a.b />',
  '{1 + 1}',
  '{',
  '}',
  '{/* c */}\n',
  'import a from "a"\n',
  'export const b = 1\n',
  'export {',
  '<!-- c -->\n',
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<a href="javascript:alert(1)">',
  '[x](javascript:alert(1))',
  '<svg onload=alert(1)>',
  '<b>',
  '</b>',
  '<table><td>',
  '<?',
  '<div>\n',
  '</div>\n',
  'www.a.com ',
  'a@b.co ',
  'https://a.b ',
  '&amp;',
  '\\',
  '\t',
  ' ',
  '  ',
  '    ',
  '\n',
  '\n\n',
  '\r\n',
  '\r',
  '\r\n\r\n',
  BOM,
  '\u0000',
  NBSP,
  LINE_SEPARATOR,
  '\u0085',
  '\u{1f600}',
  '\ud800',
  '日本語',
  'عربي',
];

const piece = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom(...FRAGMENTS) },
  { weight: 1, arbitrary: fc.string({ unit: 'binary', maxLength: 8 }) },
);

const pieces = fc.array(piece, { maxLength: 40 }).map((parts) => parts.join(''));

export const documentArbitrary = fc.oneof(
  { weight: 4, arbitrary: pieces },
  { weight: 1, arbitrary: pieces.map((text) => `${BOM}${text}`) },
  { weight: 1, arbitrary: pieces.map((text) => text.replaceAll('\n', '\r\n')) },
  { weight: 1, arbitrary: fc.string({ unit: 'binary', maxLength: 200 }) },
);

export const dialectArbitrary = fc.constantFrom<Dialect>('mdx', 'md');
