import { describe, expect, it } from 'vitest';
import { checkCustomCss } from '../src/render.ts';
import type { CssProblemCode } from '../src/render.ts';

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
    ['@\\69mport "a.css";', 'css.import'],
    ['@\\000069 mport "a.css";', 'css.import'],
    ['@im\\port "a.css";', 'css.import'],
    ['a { b: url(http://a.example/c); }', 'css.foreign_url'],
    ['a { b: url(//a.example/c); }', 'css.foreign_url'],
    ['a { b: url(/\\a.example/c); }', 'css.foreign_url'],
    ['a { b: url(data:image/svg+xml,a); }', 'css.foreign_url'],
    ['a { b: url(javascript:alert(1)); }', 'css.foreign_url'],
    ['a { b: URL("javascript:alert(1)"); }', 'css.foreign_url'],
    ['a { b: ur\\6c("javascript:alert(1)"); }', 'css.foreign_url'],
    ['a { b: u\\72 l(http://a.example); }', 'css.foreign_url'],
    ['a { b: url(  "\\6a avascript:alert(1)"  ); }', 'css.foreign_url'],
    ['a { b: url("java\\\nscript:alert(1)"); }', 'css.foreign_url'],
    ['a { b: url(', 'css.parse_failed'],
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
