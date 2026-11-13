import { createElement, type ReactElement } from 'react';
import { organizationId, projectId } from '@drefyn/tenancy';
import { Badge, ButtonLink, Mark, StatusDot, StatusPip } from '@drefyn/ui/react';
import {
  renderDocsPage,
  renderStatusPage,
  type PageInput,
  type RenderedPage,
  type SitePageData,
} from '../src/index.ts';

export const ORIGIN = 'http://site.localhost';

const tenant = {
  organizationId: organizationId('00000000-0000-4000-8000-000000000001'),
  projectId: projectId('00000000-0000-4000-8000-000000000002'),
};

// Stand ins for status.js and docs.js: each marks the page so a test can see it ran.
export const SCRIPTS: Readonly<Record<string, string>> = {
  '/status.js': 'document.documentElement.dataset.scriptRan = "status";',
  '/docs.js': 'document.documentElement.dataset.scriptRan = "docs";',
};

export interface BuiltPage {
  readonly path: string;
  readonly kind: string;
  readonly script: string | undefined;
  readonly html: string;
  readonly csp: string;
}

const statusHome = createElement(
  'main',
  { className: 'page' },
  createElement(Mark, { label: 'Acme' }),
  createElement(StatusDot, { state: 'live', children: 'All systems running' }),
  createElement(StatusPip, { state: 'fresh', label: 'Running' }),
  createElement(ButtonLink, { href: '/subscribe', children: 'Subscribe' }),
);

const incident = createElement(
  'main',
  { className: 'page incident' },
  createElement('h1', null, 'Elevated errors on the API'),
  createElement(Badge, { state: 'stale', children: 'Investigating' }),
  createElement('p', null, 'We are looking into it.'),
);

const article = createElement(
  'main',
  { className: 'page article' },
  createElement('h1', null, 'Getting started'),
  createElement('p', null, 'Install the CLI.'),
  createElement('pre', null, createElement('code', null, 'npm install acme')),
);

function input(
  route: string,
  body: ReactElement,
  css: string,
  script: string | undefined,
): PageInput<SitePageData> {
  return {
    tenant,
    route,
    locale: 'en',
    theme: { light: { '--dr-surface-ground': '#FFFFFF' }, dark: { '--dr-text-ink': '#F5F5F4' } },
    policy: { version: 1, maxFirstResponseBytes: 14_000 },
    data: {
      version: 'ver-1',
      builtAt: '2026-11-05T12:00:00.000Z',
      css,
      scripts: script === undefined ? [] : [{ kind: 'script', href: script, gzipBytes: 100 }],
      pages: new Map([[route, { title: 'Acme', description: 'Acme pages.', body }]]),
    },
  };
}

const CSS = '.page{color:var(--dr-text-ink);background:var(--dr-surface-ground)}';

function built(
  path: string,
  kind: string,
  script: string | undefined,
  result: ReturnType<typeof renderStatusPage>,
): BuiltPage {
  if (!result.ok) throw new Error(`${kind} did not render: ${result.error.code}`);
  const page: RenderedPage = result.value;
  return { path, kind, script, html: page.html, csp: page.csp };
}

// One of each page type on both surfaces, including CSS a Windows checkout could carry.
export const PAGES: readonly BuiltPage[] = [
  built(
    '/status/',
    'status home',
    '/status.js',
    renderStatusPage(input('/', statusHome, CSS, '/status.js')),
  ),
  built(
    '/status/incident',
    'status incident',
    undefined,
    renderStatusPage(input('/incident', incident, `${CSS}.incident h1{margin:0}`, undefined)),
  ),
  built(
    '/docs/',
    'docs article',
    '/docs.js',
    renderDocsPage(input('/', article, `${CSS}.article pre{overflow:auto}`, '/docs.js')),
  ),
  built(
    '/docs/crlf',
    'docs with CR LF CSS',
    undefined,
    renderDocsPage(input('/crlf', article, '.page{\r\ncolor:var(--dr-text-ink)\r\n}', undefined)),
  ),
];

// What an attacker who got markup into a page would try. None of it may run or apply.
export const INJECTED = [
  '<script>window.__pwned = "inline"</script>',
  '<script src="data:text/javascript,window.__pwned=%22data%22"></script>',
  '<img src="/missing.png" onerror="window.__pwned = &quot;handler&quot;">',
  '<style>.page{color:rgb(255, 0, 0)}</style>',
  '<p id="styled" style="color:rgb(255, 0, 0)">x</p>',
].join('');

export const tamper = (html: string): string => html.replace('</main>', `${INJECTED}</main>`);
