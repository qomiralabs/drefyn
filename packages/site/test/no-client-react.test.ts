import { createElement, lazy, Suspense } from 'react';
import { Badge, ButtonLink, Mark, StatusDot, StatusPip } from '@drefyn/ui/react';
import { themeScript } from '@drefyn/ui';
import { describe, expect, it } from 'vitest';
import { renderDocsPage, renderStatusPage } from '../src/index.ts';
import { pageInput } from './fixtures.ts';

const realPage = createElement(
  'main',
  { className: 'page' },
  createElement(Mark, { label: 'Acme' }),
  createElement(Badge, { state: 'fresh', children: 'Running' }),
  createElement(StatusDot, { state: 'live', children: 'Running' }),
  createElement(StatusPip, { state: 'fresh', label: 'Running' }),
  createElement(ButtonLink, { href: '/subscribe', children: 'Subscribe' }),
);

const MARKERS = [
  /<!--\$/,
  /<!--\/\$/,
  /<template/,
  /data-reactroot/,
  /data-react/,
  /\$RC|\$RS|\$RX/,
  /__next/i,
  /react-dom/,
  /hydrate/i,
];

describe.each([
  ['docs', renderDocsPage],
  ['status', renderStatusPage],
] as const)('%s output with real @drefyn/ui components', (_, render) => {
  const result = render(
    pageInput(
      {},
      {
        pages: new Map([['/', { title: 'Acme', description: 'Acme.', body: realPage }]]),
        scripts: [{ kind: 'script', href: '/assets/page.js', gzipBytes: 4_100 }],
      },
    ),
  );
  if (!result.ok) throw new Error(result.error.code);
  const { html } = result.value;

  it('renders them', () => {
    expect(html).toContain('Subscribe');
    expect(html).toContain('Running');
  });

  it.each(MARKERS)('holds no %s', (marker) => {
    expect(html).not.toMatch(marker);
  });

  it('holds only the theme line and the page script', () => {
    const scripts = [...html.matchAll(/<script[^>]*>/g)].map((m) => m[0]);
    expect(scripts).toEqual(['<script>', '<script defer src="/assets/page.js">']);
    expect(html).toContain(`<script>${themeScript}</script>`);
  });

  it('holds no event handler', () => {
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });
});

describe('a suspending component', () => {
  it('fails the page rather than ship a client boundary', () => {
    const Never = lazy(() => new Promise<{ default: () => null }>(() => undefined));
    const body = createElement(
      Suspense,
      { fallback: createElement('p', null, 'Loading') },
      createElement(Never),
    );
    const result = renderDocsPage(
      pageInput({}, { pages: new Map([['/', { title: 'A', description: 'B', body }]]) }),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('site.render_failed');
  });
});
