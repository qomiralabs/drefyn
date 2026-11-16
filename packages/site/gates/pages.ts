import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createElement, type ReactElement } from 'react';
import { organizationId, projectId } from '@drefyn/tenancy';
import { renderDocsPage, renderStatusPage } from '../src/index.ts';
import type { PageInput, RenderedPage, SitePageData, Surface } from '../src/types.ts';
import { FIRST_RESPONSE_FAIL_BYTES, FIRST_RESPONSE_WARN_BYTES } from './budgets.ts';
import { incompressible } from '../test/fixtures.ts';
import { noisePng } from './png.ts';
import {
  DOCS_CSS,
  STATUS_CSS,
  docsArticle,
  statusHome,
  statusIncident,
  type Extras,
} from './templates.ts';

export const PORT = 4180;
export const ORIGIN = `http://127.0.0.1:${String(PORT)}`;

// The set the gates run on is chosen by this variable, so a control run can swap one page
// for its broken twin while every gate and every other page stay exactly as they are.
export const BREACH_ENV = 'DREFYN_SITE_GATE_BREACH';

// Enough updates for a long incident that still fits under the warning target. A template
// change that grows it past the target fails the first response gate.
export const LARGEST_INCIDENT_UPDATES = 72;

export interface Asset {
  readonly type: string;
  readonly body: Buffer;
}

export interface GatePage {
  readonly id: string;
  readonly surface: Surface;
  readonly path: string;
  readonly html: string;
  readonly csp: string;
  // Text a reader must see with scripts off.
  readonly mustShow: readonly string[];
  readonly largestIncident: boolean;
}

export interface GateSet {
  readonly pages: readonly GatePage[];
  readonly assets: ReadonlyMap<string, Asset>;
}

const tenant = {
  organizationId: organizationId('00000000-0000-4000-8000-000000000001'),
  projectId: projectId('00000000-0000-4000-8000-000000000002'),
};

const JS = 'text/javascript; charset=utf-8';

// Stand ins for status.js and docs.js, each the size the real one is planned at, so the JS
// count in the browser has something real to weigh.
const DOCS_JS = `document.documentElement.dataset.scriptRan="docs";/*${incompressible(7_000)}*/`;
const STATUS_JS = `document.documentElement.dataset.scriptRan="status";/*${incompressible(4_000)}*/`;

const fontsDir = join(
  dirname(fileURLToPath(import.meta.resolve('@drefyn/ui/package.json'))),
  'src',
  'fonts',
);
const FONTS = [
  'inter-latin-400-normal.woff2',
  'inter-latin-600-normal.woff2',
  'jetbrains-mono-latin-400-normal.woff2',
];

// A small image for the breach that leaves out its alt text.
const DOT = `data:image/png;base64,${noisePng(8, 8).toString('base64')}`;

interface Draft {
  id: string;
  surface: Surface;
  path: string;
  route: string;
  title: string;
  description: string;
  body: ReactElement;
  css: string;
  script: { href: string; body: string; declared: number } | undefined;
  mustShow: string[];
  largestIncident: boolean;
}

export const BREACHES = [
  'docs-js',
  'docs-lighthouse',
  'status-js',
  'status-lighthouse',
  'status-lcp',
  'no-script',
  'first-response-warn',
  'first-response-fail',
  'axe',
  'keyboard',
  'reduced-motion',
  'visual',
] as const;
export type Breach = (typeof BREACHES)[number];

export function breachFrom(env: Readonly<Record<string, string | undefined>>): Breach | undefined {
  const raw = env[BREACH_ENV];
  if (raw === undefined || raw === '') return undefined;
  const found = BREACHES.find((b) => b === raw);
  if (found === undefined) throw new Error(`${BREACH_ENV} must be one of ${BREACHES.join(', ')}`);
  return found;
}

const gz = (text: string) => gzipSync(text, { level: 9 }).length;

function docsDraft(extras: Extras = {}, css = DOCS_CSS): Draft {
  return {
    id: 'docs-article',
    surface: 'docs',
    path: '/docs/quickstart',
    route: '/quickstart',
    title: 'Quickstart, Acme docs',
    description: 'Send your first Acme API request in under five minutes.',
    body: docsArticle(extras),
    css,
    script: { href: '/docs.js', body: DOCS_JS, declared: gz(DOCS_JS) },
    mustShow: ['Quickstart', 'Install the CLI', 'npm install --global acme'],
    largestIncident: false,
  };
}

function statusHomeDraft(extras: Extras = {}, css = STATUS_CSS): Draft {
  return {
    id: 'status-home',
    surface: 'status',
    path: '/status/',
    route: '/',
    title: 'Acme status',
    description: 'Live state of every Acme service, checked from five regions.',
    body: statusHome(extras),
    css,
    script: { href: '/status.js', body: STATUS_JS, declared: gz(STATUS_JS) },
    mustShow: ['Webhooks are delayed', 'Webhooks', 'Degraded', 'Subscribe to updates'],
    largestIncident: false,
  };
}

function incidentDraft(updates: number): Draft {
  return {
    id: 'status-incident',
    surface: 'status',
    path: '/status/incident',
    route: '/incident',
    title: 'Webhook deliveries are delayed, Acme status',
    description: 'Updates on delayed webhook deliveries.',
    body: statusIncident(updates),
    css: STATUS_CSS,
    script: undefined,
    mustShow: ['Webhook deliveries are delayed', 'Degraded', 'Investigating'],
    largestIncident: true,
  };
}

function input(draft: Draft): PageInput<SitePageData> {
  return {
    tenant,
    route: draft.route,
    locale: 'en',
    theme: {},
    policy: { version: 1, maxFirstResponseBytes: FIRST_RESPONSE_WARN_BYTES },
    data: {
      version: 'gate-1',
      builtAt: '2026-11-05T12:00:00.000Z',
      css: draft.css,
      scripts:
        draft.script === undefined
          ? []
          : [{ kind: 'script', href: draft.script.href, gzipBytes: draft.script.declared }],
      pages: new Map([
        [draft.route, { title: draft.title, description: draft.description, body: draft.body }],
      ]),
    },
  };
}

function render(draft: Draft): RenderedPage {
  const rendered = (draft.surface === 'docs' ? renderDocsPage : renderStatusPage)(input(draft));
  if (!rendered.ok) {
    throw new Error(`${draft.id} did not render: ${JSON.stringify(rendered.error)}`);
  }
  return rendered.value;
}

// The fewest updates whose incident page lands at or past `min` gzipped bytes. A control
// uses it to sit just inside the warning band, whatever the template weighs today.
export function incidentUpdatesFrom(min: number): number {
  for (let updates = 1; updates < 500; updates += 1) {
    const rendered = renderStatusPage(input(incidentDraft(updates)));
    const bytes = rendered.ok
      ? rendered.value.report.htmlGzipBytes
      : rendered.error.code === 'site.budget_exceeded'
        ? rendered.error.actual
        : 0;
    if (bytes >= min) return updates;
  }
  throw new Error(`no incident reaches ${String(min)} bytes`);
}

// The breach a control run asks for replaces the page it names, keeping its id and path, so
// the gates cannot tell it apart from a real regression on that page.
function drafts(breach: Breach | undefined): Draft[] {
  const hidden = createElement('img', { src: DOT, width: 8, height: 8, className: 'dot' });
  const faint = '.lede,.meta{color:#D6D3D1}';
  const docs = (() => {
    switch (breach) {
      case 'docs-js': {
        const body = `${DOCS_JS}/*${incompressible(160_000)}*/`;
        // The declared size is the lie a stale build report would tell.
        return { ...docsDraft(), script: { href: '/docs.js', body, declared: 7_000 } };
      }
      case 'docs-lighthouse':
        return docsDraft({ extra: hidden }, DOCS_CSS + faint);
      case 'axe':
        return docsDraft({ extra: hidden });
      case 'keyboard':
        return docsDraft({}, `${DOCS_CSS}a:focus-visible{outline:none}`);
      case 'reduced-motion':
        return docsDraft({}, `${DOCS_CSS}.brand{transition:translate 300ms ease}`);
      case 'visual':
        return docsDraft({}, `${DOCS_CSS}.article h1{letter-spacing:0.02em}`);
      default:
        return docsDraft();
    }
  })();
  const home = (() => {
    switch (breach) {
      case 'status-js': {
        const body = `${STATUS_JS}/*${incompressible(90_000)}*/`;
        return { ...statusHomeDraft(), script: { href: '/status.js', body, declared: 4_000 } };
      }
      case 'status-lighthouse':
        return statusHomeDraft({ extra: hidden }, STATUS_CSS + faint);
      case 'status-lcp': {
        const hero = createElement('img', {
          src: '/hero.png',
          alt: 'Map of the five check regions',
          width: 640,
          height: 80,
          className: 'hero',
        });
        return statusHomeDraft(
          { extra: hero },
          `${STATUS_CSS}.hero{display:block;width:100%;height:auto}`,
        );
      }
      case 'no-script':
        // Content that waits for status.js, the most common way a page breaks without it.
        return {
          ...statusHomeDraft({ mainClass: 'wait' }, `${STATUS_CSS}.wait{visibility:hidden}`),
          script: {
            href: '/status.js',
            body: `${STATUS_JS}document.querySelector(".wait").classList.remove("wait");`,
            declared: 4_100,
          },
        };
      default:
        return statusHomeDraft();
    }
  })();
  const updates =
    breach === 'first-response-warn'
      ? incidentUpdatesFrom(FIRST_RESPONSE_WARN_BYTES)
      : breach === 'first-response-fail'
        ? incidentUpdatesFrom(FIRST_RESPONSE_FAIL_BYTES)
        : LARGEST_INCIDENT_UPDATES;
  return [docs, home, incidentDraft(updates)];
}

export function buildGateSet(breach: Breach | undefined): GateSet {
  const assets = new Map<string, Asset>();
  for (const file of FONTS) {
    assets.set(`/fonts/${file}`, { type: 'font/woff2', body: readFileSync(join(fontsDir, file)) });
  }
  if (breach === 'status-lcp') {
    assets.set('/hero.png', { type: 'image/png', body: noisePng(640, 80) });
  }
  const pages = drafts(breach).map((draft): GatePage => {
    if (draft.script !== undefined) {
      assets.set(draft.script.href, { type: JS, body: Buffer.from(draft.script.body) });
    }
    const page = render(draft);
    return {
      id: draft.id,
      surface: draft.surface,
      path: draft.path,
      html: page.html,
      csp: page.csp,
      mustShow: draft.mustShow,
      largestIncident: draft.largestIncident,
    };
  });
  return { pages, assets };
}
