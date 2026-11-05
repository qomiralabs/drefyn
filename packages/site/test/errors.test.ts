import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderDocsPage, renderStatusPage, type SiteLogger } from '../src/index.ts';
import { article, incompressible, pageInput } from './fixtures.ts';

const big = (bytes: number) =>
  new Map([
    ['/', { title: 'A', description: 'B', body: createElement('p', null, incompressible(bytes)) }],
  ]);

const script = (gzipBytes: number) => ({ kind: 'script', href: '/a.js', gzipBytes }) as const;

describe('site.unknown_route', () => {
  it.each([
    ['docs', renderDocsPage],
    ['status', renderStatusPage],
  ] as const)('%s refuses a route it has no page for', (_, render) => {
    const result = render(pageInput({ route: '/nope' }));
    expect(result).toEqual({ ok: false, error: { code: 'site.unknown_route' } });
  });

  it('does not read a route off the prototype of a plain object', () => {
    const result = renderDocsPage(pageInput({ route: '__proto__' }));
    expect(!result.ok && result.error.code).toBe('site.unknown_route');
  });
});

describe('site.budget_exceeded', () => {
  it('fails docs at 90 KB of JS and passes just under', () => {
    const over = renderDocsPage(pageInput({}, { scripts: [script(90_000)] }));
    expect(over.ok).toBe(false);
    expect(!over.ok && over.error).toMatchObject({
      code: 'site.budget_exceeded',
      budget: 'js',
      limit: 90_000,
    });
    expect(renderDocsPage(pageInput({}, { scripts: [script(89_000)] })).ok).toBe(true);
  });

  it('fails status at 50 KB of JS and passes just under', () => {
    const over = renderStatusPage(pageInput({}, { scripts: [script(50_000)] }));
    expect(!over.ok && over.error).toMatchObject({
      code: 'site.budget_exceeded',
      budget: 'js',
      limit: 50_000,
    });
    expect(renderStatusPage(pageInput({}, { scripts: [script(49_000)] })).ok).toBe(true);
  });

  it('counts the inline theme line as JS', () => {
    const result = renderStatusPage(pageInput());
    expect(result.ok && result.value.report.jsGzipBytes).toBeGreaterThan(0);
  });

  it('adds every script to the report', () => {
    const none = renderDocsPage(pageInput());
    const two = renderDocsPage(pageInput({}, { scripts: [script(1_000), script(2_000)] }));
    if (!none.ok || !two.ok) throw new Error('expected both pages');
    expect(two.value.report.jsGzipBytes).toBe(none.value.report.jsGzipBytes + 3_000);
  });

  it('fails a status page whose first response reaches 16000 bytes', () => {
    const result = renderStatusPage(pageInput({}, { pages: big(40_000) }));
    expect(!result.ok && result.error).toMatchObject({
      code: 'site.budget_exceeded',
      budget: 'first_response',
      limit: 16_000,
    });
  });

  it('warns between the target and the hard limit, and still renders', () => {
    const warn = vi.fn<SiteLogger['warn']>();
    const result = renderStatusPage(pageInput({}, { pages: big(19_000) }), { log: { warn } });
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.report.htmlGzipBytes).toBeGreaterThanOrEqual(14_000);
    expect(result.value.report.htmlGzipBytes).toBeLessThan(16_000);
    expect(result.value.report.overFirstResponseTarget).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      'site.first_response_over_target',
      expect.objectContaining({ htmlGzipBytes: result.value.report.htmlGzipBytes }),
    );
  });

  it('stays quiet under the target', () => {
    const warn = vi.fn<SiteLogger['warn']>();
    const result = renderStatusPage(pageInput(), { log: { warn } });
    expect(result.ok && result.value.report.overFirstResponseTarget).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('takes a lower target from the policy', () => {
    const result = renderStatusPage(
      pageInput({ policy: { version: 1, maxFirstResponseBytes: 10 } }),
    );
    expect(result.ok && result.value.report.overFirstResponseTarget).toBe(true);
  });

  it('holds docs to no first response limit', () => {
    const result = renderDocsPage(pageInput({}, { pages: big(40_000) }));
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.report.overFirstResponseTarget).toBe(false);
  });

  it('fails a status page that brings a font', () => {
    const css = '@font-face{font-family:X;src:url("/fonts/x.woff2")}';
    const result = renderStatusPage(pageInput({}, { css }));
    expect(!result.ok && result.error).toMatchObject({
      code: 'site.budget_exceeded',
      budget: 'fonts',
      limit: 0,
      actual: 1,
    });
  });

  it('fails a docs page that brings a fourth font file', () => {
    const css = '@font-face{font-family:X;src:url("/fonts/x.woff2")}';
    const result = renderDocsPage(pageInput({}, { css }));
    expect(!result.ok && result.error).toMatchObject({
      code: 'site.budget_exceeded',
      budget: 'fonts',
      limit: 3,
      actual: 4,
    });
  });
});

describe('site.render_failed', () => {
  const failed = (result: ReturnType<typeof renderDocsPage>) => !result.ok && result.error;

  it('holds a component that throws, without its message', () => {
    const Boom = () => {
      throw new Error('private page text');
    };
    const pages = new Map([['/', { title: 'A', description: 'B', body: createElement(Boom) }]]);
    const result = renderDocsPage(pageInput({}, { pages }));
    expect(failed(result)).toEqual({ code: 'site.render_failed', reason: 'component_threw' });
    expect(JSON.stringify(result)).not.toContain('private page text');
  });

  it.each([
    ['a forged tenant', pageInput({ tenant: { organizationId: 'x', projectId: 'y' } as never })],
    ['a bad locale', pageInput({ locale: '"><script>' })],
    ['a zero version', pageInput({ policy: { version: -1, maxFirstResponseBytes: 14_000 } })],
    [
      'a target past the hard limit',
      pageInput({ policy: { version: 1, maxFirstResponseBytes: 16_001 } }),
    ],
    ['a bad build time', pageInput({}, { builtAt: 'yesterday' })],
    [
      'an offsite script',
      pageInput({}, { scripts: [{ kind: 'script', href: 'https://x.test/a.js', gzipBytes: 1 }] }),
    ],
    [
      'a protocol relative script',
      pageInput({}, { scripts: [{ kind: 'script', href: '//x.test/a.js', gzipBytes: 1 }] }),
    ],
    [
      'a fractional size',
      pageInput({}, { scripts: [{ kind: 'script', href: '/a.js', gzipBytes: 1.5 }] }),
    ],
    [
      'a body that is no element',
      pageInput(
        {},
        { pages: new Map([['/', { title: 'A', description: 'B', body: 'text' as never }]]) },
      ),
    ],
    [
      'a theme value that closes the style',
      pageInput({ theme: { light: { '--dr-surface-ground': '#000</style>' } } }),
    ],
    [
      'a theme font that fetches',
      pageInput({ theme: { light: { '--dr-font-sans': 'url(https://x.test/f.woff2)' } } }),
    ],
    [
      'a locked state colour',
      pageInput({ theme: { light: { '--dr-state-broken-text': '#000000' } as never } }),
    ],
  ])('refuses %s', (_, input) => {
    expect(failed(renderDocsPage(input))).toEqual({
      code: 'site.render_failed',
      reason: 'invalid_input',
    });
  });

  it.each([
    ['a closing style tag', '.page::after{content:"</style><script>"}'],
    ['an import', '@import "https://x.test/a.css";.page{color:red}'],
    ['an offsite image', '.page{background:url(https://x.test/a.png)}'],
    ['a protocol relative image', '.page{background:url("//x.test/a.png")}'],
  ])('refuses CSS with %s', (_, css) => {
    expect(failed(renderDocsPage(pageInput({}, { css })))).toEqual({
      code: 'site.render_failed',
      reason: 'unsafe_css',
    });
  });

  it('allows same site and data images', () => {
    const css = '.page{background:url(/a.png);mask:url("data:image/svg+xml,x")}';
    expect(renderDocsPage(pageInput({}, { css })).ok).toBe(true);
  });

  it('renders a theme into both modes', () => {
    const result = renderStatusPage(
      pageInput(
        {
          theme: {
            light: { '--dr-text-ink': '#111111' },
            dark: { '--dr-text-ink': '#EEEEEE', '--dr-font-sans': '"Acme Sans", sans-serif' },
          },
        },
        { pages: new Map([['/', { title: 'A', description: 'B', body: article() }]]) },
      ),
    );
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.html).toContain('--dr-text-ink:#111111');
    expect(result.value.html).toContain('--dr-text-ink:#EEEEEE');
  });
});
