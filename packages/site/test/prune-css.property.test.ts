import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pruneCss } from '../src/index.ts';

const name = fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/);
const pool = fc.uniqueArray(name, { minLength: 2, maxLength: 12 });

const rule = (cls: string, prop: string) => `.${cls}{--${prop}:1;color:var(--${prop})}`;

describe('pruneCss', () => {
  it('keeps what a page uses and drops the rest', () => {
    fc.assert(
      fc.property(
        pool.chain((names) =>
          fc.tuple(fc.constant(names), fc.integer({ min: 1, max: names.length - 1 })),
        ),
        ([names, split]) => {
          const used = names.slice(0, split);
          const unused = names.slice(split);
          const css = names.map((n) => rule(`c${n}`, `p${n}`)).join('');
          const html = `<div class="${used.map((n) => `c${n}`).join(' ')}"></div>`;
          const out = pruneCss(html, css);
          for (const n of used) {
            expect(out).toContain(`.c${n}{`);
            expect(out).toContain(`--p${n}:1`);
          }
          for (const n of unused) {
            expect(out).not.toContain(`.c${n}{`);
            expect(out).not.toContain(`--p${n}:`);
          }
        },
      ),
    );
  });

  it('follows custom properties through each other', () => {
    fc.assert(
      fc.property(pool, (names) => {
        const chain = names.map((n, i) => {
          const next = names[i + 1];
          return `--${n}:${next === undefined ? '1px' : `var(--${next})`}`;
        });
        const first = names[0] ?? '';
        const css = `:root{${chain.join(';')};--dropped:2px}.a{margin:var(--${first})}`;
        const out = pruneCss('<a class="a"></a>', css);
        for (const n of names) expect(out).toContain(`--${n}:`);
        expect(out).not.toContain('--dropped');
      }),
    );
  });

  it('is stable when run again', () => {
    fc.assert(
      fc.property(pool, (names) => {
        const css = names.map((n) => rule(`c${n}`, `p${n}`)).join('\n');
        const html = `<i class="c${names[0] ?? ''}"></i>`;
        const once = pruneCss(html, css);
        expect(pruneCss(html, once)).toBe(once);
      }),
    );
  });

  it('never throws on noise', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), fc.string({ maxLength: 100 }), (css, html) => {
        expect(typeof pruneCss(html, css)).toBe('string');
      }),
    );
  });

  it('never throws on rule shaped noise', () => {
    const piece = fc.constantFrom(
      '{',
      '}',
      ';',
      ':',
      '(',
      ')',
      '"',
      "'",
      '/*',
      '*/',
      '\\',
      '@a',
      '.b',
      '--c',
      ',',
      'url(',
    );
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 60 }), (parts) => {
        expect(typeof pruneCss('<p class="b"></p>', parts.join(''))).toBe('string');
      }),
    );
  });
});

const keep = (html: string, css: string) => pruneCss(html, css);

describe('pruneCss selectors', () => {
  it.each([
    ['a compound selector needs every class', '<p class="a"></p>', '.a.b{color:red}', ''],
    ['a descendant needs both', '<p class="a"></p>', '.a .b{color:red}', ''],
    [
      'a list keeps only its live selectors',
      '<p class="a"></p>',
      '.a,.b{color:red}',
      '.a{color:red}',
    ],
    [
      'a pseudo class stays with its class',
      '<p class="a"></p>',
      '.a:hover{color:red}',
      '.a:hover{color:red}',
    ],
    ['elements stay', '<p></p>', 'p{color:red}', 'p{color:red}'],
    ['attributes stay', '<p></p>', '[data-x=".b"]{color:red}', '[data-x=".b"]{color:red}'],
    ['the root stays', '<p></p>', ':root{color-scheme:light}', ':root{color-scheme:light}'],
    ['not cannot need its class', '<p></p>', 'p:not(.b){color:red}', 'p:not(.b){color:red}'],
    [
      'where keeps a live branch',
      '<p class="a"></p>',
      ':where(.a,.b){color:red}',
      ':where(.a,.b){color:red}',
    ],
    ['where drops a dead one', '<p></p>', ':where(.a,.b){color:red}', ''],
    ['is drops a dead one', '<p></p>', 'p:is(.a){color:red}', ''],
    ['has drops a dead one', '<p></p>', 'p:has(.a > span){color:red}', ''],
    [
      'a class in a nested function stays',
      '<p></p>',
      'p:nth-child(2n of .a){color:red}',
      'p:nth-child(2n of .a){color:red}',
    ],
  ])('%s', (_, html, css, expected) => {
    expect(keep(html, css)).toBe(expected);
  });

  it('reads escaped utility names', () => {
    const html = '<p class="sm:flex w-1/2 [&amp;_svg]:size-4"></p>';
    const css =
      '.sm\\:flex{display:flex}.w-1\\/2{width:50%}.\\[\\&_svg\\]\\:size-4 svg{width:1rem}.md\\:flex{display:flex}';
    expect(keep(html, css)).toBe(
      '.sm\\:flex{display:flex}.w-1\\/2{width:50%}.\\[\\&_svg\\]\\:size-4 svg{width:1rem}',
    );
  });

  it('reads every way html writes a class', () => {
    expect(keep(`<a class='a'></a><b class=b></b>`, '.a{top:0}.b{top:1px}.c{top:2px}')).toBe(
      '.a{top:0}.b{top:1px}',
    );
    expect(keep('<a class="&#x61;&#98;"></a>', '.ab{top:0}')).toBe('.ab{top:0}');
  });

  it('does not take page text for a class', () => {
    expect(keep('<p>class=&quot;a&quot;</p>', '.a{top:0}')).toBe('');
  });
});

describe('pruneCss blocks', () => {
  it('goes inside media, supports, layer and container', () => {
    const css =
      '@media (width < 40rem){.a{top:0}.b{top:1px}}@supports (display:grid){.b{top:2px}}@layer x{.a{top:3px}}@container (width > 1px){.b{top:4px}}';
    expect(keep('<p class="a"></p>', css)).toBe(
      '@media (width < 40rem){.a{top:0}}@layer x{.a{top:3px}}',
    );
  });

  it('keeps font faces, keyframes and statements as written', () => {
    const css =
      '@charset "utf-8";@layer a,b;@font-face{font-family:X;src:url("/x.woff2")}@keyframes s{from{top:0}to{top:1px}}';
    expect(keep('', css)).toBe(css);
  });

  it('counts a property a keyframe reads', () => {
    expect(keep('', ':root{--a:1;--b:2}@keyframes s{to{top:var(--a)}}')).toBe(
      ':root{--a:1}@keyframes s{to{top:var(--a)}}',
    );
  });

  it('keeps a registered property only while something uses it', () => {
    const css =
      '@property --a{syntax:"*";inherits:false}@property --b{syntax:"*";inherits:false}.x{top:var(--a)}';
    expect(keep('<p class="x"></p>', css)).toBe(
      '@property --a{syntax:"*";inherits:false}.x{top:var(--a)}',
    );
  });

  it('handles rules nested in rules', () => {
    expect(keep('<p class="a"></p>', '.a{top:0;&:hover{top:1px}.b{top:2px}}')).toBe(
      '.a{top:0;&:hover{top:1px}}',
    );
  });

  it('removes a rule left with nothing', () => {
    expect(keep('<p class="a"></p>', '.a{--x:1}')).toBe('');
  });

  it('removes comments and leaves strings and urls alone', () => {
    const css = '/* note */.a{content:"}/*x*/";background:url(data:a;b)}';
    expect(keep('<p class="a"></p>', css)).toBe('.a{content:"}/*x*/";background:url(data:a;b)}');
  });

  it('keeps a dashed name used without var', () => {
    expect(keep('<p class="a"></p>', ':root{--t:1}.a{view-timeline-name:--t}')).toBe(
      ':root{--t:1}.a{view-timeline-name:--t}',
    );
  });

  it('counts a property named in the html', () => {
    expect(keep('<p style="color:var(--a)"></p>', ':root{--a:red;--b:blue}')).toBe(
      ':root{--a:red}',
    );
  });

  it('keeps !important', () => {
    expect(keep('<p class="a"></p>', '.a{top:0 !important}')).toBe('.a{top:0 !important}');
  });

  it('gives up on depth rather than the stack', () => {
    const css = `${'.a{'.repeat(100_000)}top:0`;
    expect(keep('<p class="a"></p>', css)).toBe(css);
    const selector = `${':is('.repeat(50_000)}.a${')'.repeat(50_000)}{top:0}`;
    expect(keep('<p class="a"></p>', selector)).toBe(selector);
  });
});
