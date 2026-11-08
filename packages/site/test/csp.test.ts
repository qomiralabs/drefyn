import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { themeScript } from '@drefyn/ui';
import { Badge, ButtonLink, StatusDot } from '@drefyn/ui/react';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, inlineHash, inlineText } from '../src/csp.ts';
import { renderDocsPage, renderStatusPage } from '../src/index.ts';
import { pageInput } from './fixtures.ts';

const sha256 = (text: string) =>
  `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

const directives = (policy: string): Map<string, string[]> =>
  new Map(
    policy
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter((tokens) => tokens[0] !== undefined && tokens[0] !== '')
      .map(([name = '', ...values]) => [name, values]),
  );

const inlineScripts = (html: string) =>
  [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
const inlineStyles = (html: string) =>
  [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? '');
const metaPolicy = (html: string) =>
  /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/
    .exec(html)?.[1]
    ?.replaceAll('&#x27;', "'");

const realBody = createElement(
  'main',
  { className: 'page' },
  createElement(Badge, { state: 'fresh', children: 'Running' }),
  createElement(StatusDot, { state: 'live', children: 'Running' }),
  createElement(ButtonLink, { href: '/subscribe', children: 'Subscribe' }),
);

const cases = [
  ['docs', renderDocsPage],
  ['status', renderStatusPage],
] as const;

const variants = [
  ['plain', pageInput()],
  [
    'themed with scripts',
    pageInput(
      {
        theme: {
          light: { '--dr-surface-ground': '#FFFFFF' },
          dark: { '--dr-text-ink': '#EEEEEE' },
        },
      },
      {
        scripts: [{ kind: 'script', href: '/status.js', gzipBytes: 1_000 }],
        pages: new Map([['/', { title: 'Acme', description: 'Live.', body: realBody }]]),
      },
    ),
  ],
] as const;

describe('inlineHash', () => {
  it('matches the sha256 a browser computes over the element text', () => {
    expect(inlineHash('')).toBe("'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='");
    expect(inlineHash(themeScript)).toBe(sha256(themeScript));
    expect(inlineHash('héllo')).toBe(sha256('héllo'));
  });

  it('gives the same hash for the same text, and a different one for different text', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(inlineHash(a)).toBe(inlineHash(a));
        if (inlineText(a) !== inlineText(b)) expect(inlineHash(a)).not.toBe(inlineHash(b));
      }),
    );
  });
});

describe('inlineText', () => {
  // The HTML parser turns CR LF and lone CR into LF and NUL into U+FFFD before a browser
  // hashes the element, so the bytes we hash must already look like that.
  it('normalizes the text the way the HTML parser does', () => {
    expect(inlineText('a\r\nb\rc\0d')).toBe('a\nb\nc�d');
    fc.assert(
      fc.property(fc.string(), (text) => {
        const once = inlineText(text);
        expect(inlineText(once)).toBe(once);
        expect(once).not.toMatch(/[\r\0]/);
      }),
    );
  });
});

describe('contentSecurityPolicy', () => {
  const policy = contentSecurityPolicy({ scripts: ["'sha256-a'"], styles: ["'sha256-b'"] });

  it('allows nothing by default and only what the page needs', () => {
    const parsed = directives(policy.header);
    expect(parsed.get('default-src')).toEqual(["'none'"]);
    expect(parsed.get('script-src')).toEqual(["'self'", "'sha256-a'"]);
    expect(parsed.get('style-src')).toEqual(["'sha256-b'"]);
    expect(parsed.get('object-src')).toEqual(["'none'"]);
    expect(parsed.get('base-uri')).toEqual(["'none'"]);
    expect(parsed.get('frame-ancestors')).toEqual(["'none'"]);
    expect(parsed.get('form-action')).toEqual(["'self'"]);
  });

  // A browser ignores these in a meta tag and logs a warning for each.
  it('leaves header only directives out of the meta policy', () => {
    const meta = directives(policy.meta);
    expect(meta.has('frame-ancestors')).toBe(false);
    expect(meta.has('report-uri')).toBe(false);
    expect(meta.has('sandbox')).toBe(false);
    expect([...meta.keys()]).toEqual(
      [...directives(policy.header).keys()].filter((k) => k !== 'frame-ancestors'),
    );
  });

  it('sorts and dedupes hashes so the same set gives the same policy', () => {
    const a = contentSecurityPolicy({
      scripts: ["'sha256-b'", "'sha256-a'", "'sha256-a'"],
      styles: [],
    });
    const b = contentSecurityPolicy({ scripts: ["'sha256-a'", "'sha256-b'"], styles: [] });
    expect(a).toEqual(b);
    expect(directives(a.header).get('style-src')).toEqual(["'none'"]);
  });
});

describe.each(cases)('%s page policy', (_, render) => {
  describe.each(variants)('%s', (_name, input) => {
    const result = render(input);
    if (!result.ok) throw new Error(`render failed: ${result.error.code}`);
    const { html, csp } = result.value;

    it('has no unsafe source for scripts or styles', () => {
      const meta = metaPolicy(html);
      expect(meta).toBeDefined();
      for (const policy of [csp, meta ?? '']) {
        expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|unsafe-hashes|\*/);
        const scriptSrc = directives(policy).get('script-src') ?? [];
        expect(scriptSrc.length).toBeGreaterThan(0);
        // A scheme source would let any host, or a data URL, run code.
        expect(scriptSrc.filter((source) => /^[a-z][a-z0-9+.-]*:/i.test(source))).toEqual([]);
      }
    });

    it('hashes every inline script and style the page carries, and nothing else', () => {
      const parsed = directives(csp);
      const scripts = inlineScripts(html);
      const styles = inlineStyles(html);
      expect(scripts).toEqual([themeScript]);
      expect(styles).toHaveLength(1);
      expect(parsed.get('script-src')).toEqual(["'self'", ...scripts.map(sha256)]);
      expect(parsed.get('style-src')).toEqual(styles.map(sha256));
    });

    it('puts the same policy, less frame-ancestors, in a meta tag before anything it guards', () => {
      const meta = metaPolicy(html);
      expect(meta).toBe(csp.replace(/;frame-ancestors 'none'/, ''));
      const at = html.indexOf('http-equiv="Content-Security-Policy"');
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(html.indexOf('<style>'));
      expect(at).toBeLessThan(html.indexOf('<script'));
    });

    it('gives the same policy for the same input', () => {
      const again = render(input);
      expect(again.ok && again.value.csp).toBe(csp);
    });
  });

  it('changes the style hash when the page CSS changes', () => {
    const a = render(pageInput());
    const b = render(pageInput({}, { css: '.page{color:var(--dr-accent-ink)}' }));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(directives(a.value.csp).get('style-src')).not.toEqual(
      directives(b.value.csp).get('style-src'),
    );
    expect(directives(a.value.csp).get('script-src')).toEqual(
      directives(b.value.csp).get('script-src'),
    );
  });

  it('emits the CSS as the browser will hash it when it carries carriage returns', () => {
    const result = render(pageInput({}, { css: '.page{\r\ncolor:var(--dr-text-ink)\r}' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [style = ''] = inlineStyles(result.value.html);
    expect(style).not.toContain('\r');
    expect(directives(result.value.csp).get('style-src')).toEqual([sha256(style)]);
  });
});
