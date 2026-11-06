import { describe, expect, it } from 'vitest';
import { checkCustomCss } from '../src/render.ts';
import type { CssProblemCode } from '../src/render.ts';
import { MAX_GROWTH, SIZE_RATIO, growthOf } from './cost.ts';

const MAX_SHEET_BYTES = 131_072;
// Only for a failing run. A passing one costs a fraction of this, and a timeout cannot stop a
// synchronous test anyway.
const GROWTH_TIMEOUT_MS = 120_000;

const codes = (css: string): readonly CssProblemCode[] => {
  const result = checkCustomCss(css);
  return result.ok ? [] : result.error.map((problem) => problem.code);
};

describe('custom CSS', () => {
  it.each([
    '',
    'a { color: red; }',
    ':root { --x: 1px; } a:not(.b):nth-child(2n) > c { margin: calc(1px + var(--x)); }',
    '@media (min-width: 40em) { a { color: rgb(0 0 0 / 50%); } }',
    '@supports (display: grid) { a { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); } }',
    '@keyframes k { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; } }',
    '@font-face { font-family: a; src: url("https://cdn.example/a.woff2") format("woff2"), local("b"); }',
    'a { background: url(/assets/a.png); }',
    'a { background: url("assets/a.png"); }',
    "a { background: url('../a.png') no-repeat; }",
    'a { background: url( https://cdn.example/a.png ); }',
    'a { content: "url(http://a.example) @import expression("; }',
    '/* @import "x"; expression( */ a { color: red; }',
    '@media (width < 40em) { a { color: red; } }',
    'a { color: red; b { color: blue; } }',
  ])('accepts %s', (css) => {
    expect(checkCustomCss(css)).toEqual({ ok: true, value: css });
  });

  it.each([
    ['@import "a.css";', 'css.import'],
    ['@import url(https://a.example/b.css);', 'css.import'],
    ['@IMPORT "a.css";', 'css.import'],
    // postcss cannot read an escape in a rule name, which refuses it all the same.
    ['@\\69mport "a.css";', 'css.parse_failed'],
    ['@\\000069 mport "a.css";', 'css.parse_failed'],
    ['@im\\port "a.css";', 'css.forbidden_at_rule'],
    ['a { b: url(http://a.example/c); }', 'css.foreign_url'],
    ['a { b: url(//a.example/c); }', 'css.foreign_url'],
    ['a { b: url("/\\\\a.example/c"); }', 'css.foreign_url'],
    ['a { b: url(data:image/svg+xml,a); }', 'css.foreign_url'],
    ['a { b: url(javascript:alert(1)); }', 'css.foreign_url'],
    ['a { b: URL("javascript:alert(1)"); }', 'css.foreign_url'],
    ['a { b: ur\\6c("javascript:alert(1)"); }', 'css.foreign_url'],
    ['a { b: u\\72 l(http://a.example); }', 'css.foreign_url'],
    ['a { b: url(  "\\6a avascript:alert(1)"  ); }', 'css.foreign_url'],
    ['a { b: url("java\\\nscript:alert(1)"); }', 'css.foreign_url'],
    ['a { b: url(', 'css.parse_failed'],
    ['a { b: url("http://["); }', 'css.foreign_url'],
    ['a { \\110000 b: url(http://a.example); }', 'css.foreign_url'],
    ['a { b: \\110000(c); }', 'css.forbidden_function'],
    ['a { b: "c\n} d { background: url(http://a.example/e); } f { g: "; }', 'css.parse_failed'],
    ["a { b: 'c\n} d { background: url(http://a.example/e); } f { g: '; }", 'css.parse_failed'],
    ['a { b: "c', 'css.parse_failed'],
    // Chromium reads the middle rule of these two as live, with the url.
    ['x{a:\\/* "\n;}b{background:url(http://evil.test/x)}c{d:"*/}', 'css.parse_failed'],
    ['a{b:url(/*)}\ne{f:"x\n;}b{background:url(http://evil.test/x)}g{h:"*/}', 'css.parse_failed'],
    ['x{a:\\/* "\r;}b{background:url(http://evil.test/x)}c{d:"*/}', 'css.parse_failed'],
    ["x{a:\\/* '\f;}b{behavior:url(/x.htc)}c{d:'*/}", 'css.parse_failed'],
    ['a[b="c\n"]{d:e}', 'css.parse_failed'],
    ['@media "c\n" { a { b: c; } }', 'css.parse_failed'],
    ['@font-face { src: url(ftp://a.example/b); }', 'css.foreign_url'],
    ['@media url(http://a.example) { a { b: c; } }', 'css.foreign_url'],
    ['a { width: expression(alert(1)); }', 'css.expression'],
    ['a { width: EXPRESSION(alert(1)); }', 'css.expression'],
    ['a { width: expr/**/ession(alert(1)); }', 'css.expression'],
    ['a { width: e\\78pression(alert(1)); }', 'css.expression'],
    ['a { width: \\65 xpression(alert(1)); }', 'css.expression'],
    ['a { width: \\000065xpression(alert(1)); }', 'css.expression'],
    ['a { width: ex\\pression(alert(1)); }', 'css.expression'],
    ['a { b: image-set("http://a.example/c" 1x); }', 'css.forbidden_function'],
    ['a { b: -webkit-image-set("http://a.example/c" 1x); }', 'css.forbidden_function'],
    ['a { b: src("http://a.example/c"); }', 'css.forbidden_function'],
    ['a { b: element(#c); }', 'css.forbidden_function'],
    ['@charset "utf-8";', 'css.forbidden_at_rule'],
    ['@namespace svg url(http://www.w3.org/2000/svg);', 'css.forbidden_at_rule'],
    ['@document url-prefix(https://a.example) { a { b: c; } }', 'css.forbidden_at_rule'],
    ['@-moz-document url-prefix() { a { b: c; } }', 'css.forbidden_at_rule'],
    ['a { behavior: url(/x.htc); }', 'css.forbidden_property'],
    ['a { -moz-binding: url(/x.xml#y); }', 'css.forbidden_property'],
    ['a { BEHAV\\49 OR: url(/x.htc); }', 'css.forbidden_property'],
    ['a { b: "</style><script>alert(1)</script>"; }', 'css.markup'],
    ['/* </style><script>alert(1)</script> */', 'css.markup'],
    ['</STYLE ><script>', 'css.markup'],
    ['<!-- a { b: c; } -->', 'css.markup'],
  ])('refuses %s', (css, code) => {
    expect(codes(css)).toContain(code);
  });

  it('reports where, and not what', () => {
    const result = checkCustomCss('a {}\n@import "secret.css";');
    expect(result).toEqual({
      ok: false,
      error: [{ code: 'css.import', line: 2, column: 1 }],
    });
  });

  it('reports a parse failure with no text of the sheet', () => {
    const result = checkCustomCss('a { "unclosed');
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('unclosed');
  });

  it('refuses a sheet past the size limit before parsing it', () => {
    expect(codes(`a{b:c}`.repeat(50_000))).toEqual(['css.too_large']);
  });

  it('reads quotes inside a comment as comment', () => {
    expect(codes('/* it\'s */ a { b: c; } /* " */')).toEqual([]);
    expect(codes('a { b: c; } /* never closed "')).toEqual(['css.parse_failed']);
  });

  it('keeps a string split with a backslash', () => {
    expect(codes('a { content: "b\\\nc"; }')).toEqual([]);
  });

  const FULL = 128_000;
  const QUARTER = FULL / SIZE_RATIO;

  // Each makes one string or token as long as the sheet allows. Every case is given as its
  // length in bytes, and the two sizes are compared.
  it.each<[string, (bytes: number) => string]>([
    ['one long word', (bytes) => `a{b:${'c'.repeat(bytes)}}`],
    ['one long escape run', (bytes) => `a{b:${'\\c'.repeat(bytes / 2)}}`],
    ['open brackets', (bytes) => `a{b:${'c('.repeat(bytes / 2)}}`],
    ['open and closed brackets', (bytes) => `a{b:${'c(d)'.repeat(bytes / 4)}}`],
    ['url brackets', (bytes) => `a{b:${'url('.repeat(bytes / 4)}}`],
    ['open comments', (bytes) => '/*'.repeat(bytes / 2)],
    ['comments in a value', (bytes) => `a{b:${'/**/c'.repeat(bytes / 5)}}`],
    ['quotes', (bytes) => `a{b:${'"'.repeat(bytes)}}`],
    ['escaped quotes ending in a backslash', (bytes) => `"${'\\"'.repeat(bytes / 2)}\\`],
    ['escaped single quotes ending in a backslash', (bytes) => `'${"\\'".repeat(bytes / 2)}\\`],
    ['strings', (bytes) => `a{b:${'"c" '.repeat(bytes / 4)}}`],
    ['many rules', (bytes) => 'a{b:c}'.repeat(bytes / 6)],
    ['many declarations', (bytes) => `a{${'b:c;'.repeat(bytes / 4)}}`],
    ['open blocks', (bytes) => 'a{'.repeat(bytes / 2)],
    ['at rules', (bytes) => '@media x{'.repeat(bytes / 9)],
    ['escapes to decode', (bytes) => `a{b:${'\\75 rl('.repeat(bytes / 7)}}`],
  ])('costs linear time on %s', { timeout: GROWTH_TIMEOUT_MS }, (_name, sheet) => {
    const small = sheet(QUARTER);
    const large = sheet(FULL);
    expect(Buffer.byteLength(large)).toBeLessThanOrEqual(MAX_SHEET_BYTES);
    const growth = growthOf(
      () => checkCustomCss(small),
      () => checkCustomCss(large),
    );
    expect(growth).toBeLessThan(MAX_GROWTH);
  });

  it('survives deep nesting', () => {
    const css = `${'a{'.repeat(40_000)}${'}'.repeat(40_000)}`;
    expect(codes(css)).toEqual([]);
  });

  it('never follows a source map comment off the disk', () => {
    expect(codes('/*# sourceMappingURL=/etc/passwd */ a { b: c; }')).toEqual([]);
    expect(codes('/*# sourceMappingURL=/definitely/not/here.map */')).toEqual([]);
  });

  it('stops at a bounded number of problems', () => {
    const result = checkCustomCss('@import "a";\n'.repeat(500));
    expect(result.ok ? 0 : result.error.length).toBe(20);
  });

  it('refuses a value that is not a string', () => {
    expect(codes(5 as unknown as string)).toEqual(['css.parse_failed']);
  });
});
