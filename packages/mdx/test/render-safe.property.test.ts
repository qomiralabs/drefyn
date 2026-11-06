import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { RenderRefused } from '../src/render.ts';
import type { Dialect, RenderPolicy } from '../src/index.ts';
import { loadCorpus, parsed, policy } from './helpers.ts';
import { dangerIn, rendered, rerendered, rootOf, toHtml } from './render-helpers.ts';
import { MEASURED, OWASP } from './xss-payloads.ts';

const RUNS = 300;
const GENERATED_TIMEOUT_MS = 60_000;
const CORPUS_TIMEOUT_MS = 120_000;
const MIN_CORPUS_REREADS = 100;

const hostile = fc.oneof(
  fc.constantFrom(...MEASURED, ...OWASP),
  fc.constantFrom(
    'javascript:alert(1)',
    ' JaVaScRiPt:alert(1)',
    'java\tscript:alert(1)',
    'vbscript:a',
    'data:text/html,a',
    '//a.example/x',
    '/\\a.example/x',
    'https://a.example/x',
    'mailto:a@b',
    '/ok',
    '#a',
    '__proto__',
    'constructor',
  ),
  fc.string({ maxLength: 12 }).filter((text) => !text.includes('\0') && text.isWellFormed()),
);

const names = fc.constantFrom('Note', 'script', 'img', 'a', 'constructor', '__proto__', 'x.y');

const attributes = fc.array(
  fc.record({
    type: fc.constant('mdxJsxAttribute'),
    name: fc.constantFrom('onClick', 'href', 'src', 'style', 'id', 'dangerouslySetInnerHTML'),
    value: fc.oneof(
      hostile,
      fc.record({ type: fc.constant('mdxJsxAttributeValueExpression'), value: hostile }),
    ),
  }),
  { maxLength: 3 },
);

// Any tree that passes the shape check, sensible or not: a stored tree comes from a host hostile
// pages run on, so its nesting is no promise.
const { tree } = fc.letrec<{ tree: unknown; list: readonly unknown[] }>((link) => ({
  list: fc.array(link('tree'), { maxLength: 3 }),
  tree: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.record({ type: fc.constant('text'), value: hostile }),
    fc.record({ type: fc.constant('html'), value: hostile }),
    fc.record({ type: fc.constant('inlineCode'), value: hostile }),
    fc.record({ type: fc.constant('mdxTextExpression'), value: hostile }),
    fc.record({ type: fc.constant('image'), url: hostile, alt: hostile, title: hostile }),
    fc.record({ type: fc.constant('code'), value: hostile, lang: hostile, meta: hostile }),
    fc.record({ type: fc.constant('definition'), identifier: hostile, url: hostile }),
    fc.record({ type: fc.constant('paragraph'), children: link('list') }),
    fc.record({ type: fc.constant('emphasis'), children: link('list') }),
    fc.record({ type: fc.constant('link'), url: hostile, title: hostile, children: link('list') }),
    fc.record({
      type: fc.constant('linkReference'),
      identifier: hostile,
      referenceType: fc.constant('full'),
      children: link('list'),
    }),
    fc.record({
      type: fc.constant('footnoteDefinition'),
      identifier: hostile,
      children: link('list'),
    }),
    fc.record({ type: fc.constant('footnoteReference'), identifier: hostile }),
    fc.record({
      type: fc.constant('heading'),
      depth: fc.integer({ min: 1, max: 6 }),
      children: link('list'),
    }),
    fc.record({
      type: fc.constantFrom('mdxJsxFlowElement', 'mdxJsxTextElement'),
      name: names,
      attributes,
      children: link('list'),
    }),
  ),
}));

const policies: fc.Arbitrary<RenderPolicy> = fc
  .record({
    components: fc.constantFrom(new Set<string>(), new Set(['Note', 'x.y'])),
    rawHtml: fc.constantFrom('sanitize' as const, 'drop' as const),
    remoteImages: fc.constantFrom('allow' as const, 'proxy' as const, 'block' as const),
    linkProtocols: fc.subarray(['https', 'http', 'mailto'] as ('https' | 'http' | 'mailto')[]),
  })
  .map((overrides) => policy(overrides));

function attempt(run: () => string): string | null {
  try {
    return run();
  } catch (error) {
    if (error instanceof RenderRefused) return null;
    throw error;
  }
}

const render = (children: readonly unknown[], use: RenderPolicy) =>
  attempt(() => toHtml(rootOf(children), use));

const allowedSchemes = (use: RenderPolicy) => [...use.linkProtocols];

const fragment = fc.constantFrom(
  '# a\n',
  'text *b* **c**\n',
  '- d\n  - e\n',
  '> f\n',
  '1. g\n',
  '| h |\n|---|\n| i |\n',
  '```js\nj\n```\n',
  '[k](/l "m")\n',
  '![n](/o)\n',
  'p[^q]\n\n[^q]: r\n',
  '<div id="s">t</div>\n',
  '<details><summary>u</summary>v</details>\n',
  '<table><tr><td>w\n',
  '<b><p>x</b>y</p>\n',
  '<a href="/z"><a href="/y">x</a>\n',
  '<pre>\n\nw</pre>\n',
  '- [x] done\n',
  ...MEASURED.map((payload) => `${payload}\n`),
  ...OWASP.map((payload) => `${payload}\n`),
);

const page = fc.array(fragment, { maxLength: 6 }).map((parts) => parts.join('\n'));

const soup = fc
  .array(
    fc.constantFrom(
      ...'a b i p div table tr td th tbody li ul ol pre h1 details summary marquee center font form select svg math style title textarea'
        .split(' ')
        .flatMap((tag) => [`<${tag}>`, `</${tag}>`]),
      'x',
      ' ',
      '\n',
      '<br>',
      '<hr>',
      '<img src=/a>',
      '<input>',
      '<!-- -->',
    ),
    { maxLength: 24 },
  )
  .map((parts) => parts.join(''));

describe('renderSafe, for any tree', { timeout: GENERATED_TIMEOUT_MS }, () => {
  it('gives no handler, script element or disallowed scheme', () => {
    fc.assert(
      fc.property(fc.array(tree, { maxLength: 4 }), policies, (children, use) => {
        const html = render(children, use);
        if (html === null) return;
        // Relative URLs resolve to https in the check, so that scheme is always fine there.
        expect(dangerIn(html, ['https', ...allowedSchemes(use)])).toEqual([]);
      }),
      { numRuns: RUNS },
    );
  });

  it('loads nothing remote when the policy blocks it', () => {
    fc.assert(
      fc.property(fc.array(tree, { maxLength: 4 }), (children) => {
        const html = render(children, policy({ remoteImages: 'block' }));
        if (html === null) return;
        for (const { groups } of html.matchAll(/ src="(?<url>[^"]*)"/g)) {
          const decoded = (groups?.['url'] ?? '').replaceAll('&amp;', '&');
          const resolved = new URL(decoded, 'https://page.invalid/');
          expect(resolved.origin).toBe('https://page.invalid');
        }
      }),
      { numRuns: RUNS },
    );
  });
});

describe('renderSafe is idempotent', { timeout: GENERATED_TIMEOUT_MS }, () => {
  it.each(['md', 'mdx'] as readonly Dialect[])('for generated %s pages', (dialect) => {
    const use = policy({ remoteImages: 'allow' });
    fc.assert(
      fc.property(page, (source) => {
        let tree;
        try {
          tree = parsed(source, dialect, use);
        } catch {
          return;
        }
        const html = toHtml(tree, use);
        expect(rerendered(html, use)).toBe(html);
      }),
      { numRuns: RUNS },
    );
  });

  it('for tag soup, where a parser rebuilds the tree', () => {
    const use = policy();
    fc.assert(
      fc.property(soup, (html) => {
        const once = toHtml(rootOf([{ type: 'html', value: html }]), use);
        expect(rerendered(once, use)).toBe(once);
        expect(dangerIn(once)).toEqual([]);
      }),
      { numRuns: RUNS },
    );
  });

  it(
    'for the corpus, which also renders inert',
    () => {
      const use = policy({ remoteImages: 'allow' });
      let rereads = 0;
      for (const { file, text, dialect } of loadCorpus()) {
        const html = rendered(text, dialect, use);
        expect(dangerIn(html), file).toEqual([]);
        // A long page's output is past what a page may hold as raw HTML, and that is all this
        // refusal says.
        const again = attempt(() => rerendered(html, use));
        if (again === null) continue;
        rereads += 1;
        expect(again, file).toBe(html);
      }
      expect(rereads).toBeGreaterThan(MIN_CORPUS_REREADS);
    },
    CORPUS_TIMEOUT_MS,
  );
});
