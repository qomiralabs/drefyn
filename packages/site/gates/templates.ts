import { createElement as h, type ReactElement, type ReactNode } from 'react';

// Stand in templates for the two surfaces, close enough to the real ones in shape and weight
// that a budget breach in a template change shows up here first. The real templates join the
// gated set when they land.

export const DOCS_CSS = `
body{margin:0;background:var(--dr-surface-ground);color:var(--dr-text-body);font:var(--dr-type-body-m)}
a{color:var(--dr-accent-ink);text-underline-offset:0.2em;transition:color var(--dr-duration-fast) var(--dr-ease-enter)}
a:focus-visible{outline:var(--dr-stroke-focus) solid var(--dr-focus-ring);outline-offset:var(--dr-stroke-focus-offset);border-radius:var(--dr-radius-xs)}
.skip{position:absolute;left:var(--dr-space-16);top:-4rem}
.skip:focus-visible{top:var(--dr-space-16)}
.bar{display:flex;align-items:center;gap:var(--dr-space-24);padding:var(--dr-space-16) var(--dr-gutter);border-bottom:var(--dr-stroke-hairline) solid var(--dr-border-rule)}
.brand{font:var(--dr-type-title);color:var(--dr-text-ink);text-decoration:none}
.frame{display:grid;gap:var(--dr-space-48);max-width:var(--dr-page-max);margin:0 auto;padding:var(--dr-space-32) var(--dr-gutter)}
@media (width >= 64rem){.frame{grid-template-columns:var(--dr-docs-nav) minmax(0,var(--dr-docs-content)) var(--dr-docs-toc)}}
.nav ul,.toc ul{list-style:none;margin:0;padding:0;display:grid;gap:var(--dr-space-8)}
.nav a,.toc a{color:var(--dr-text-secondary);text-decoration:none}
.nav [aria-current=page]{color:var(--dr-text-ink);font-weight:var(--dr-weight-strong)}
.label{font:var(--dr-type-label);letter-spacing:var(--dr-type-label-tracking);text-transform:uppercase;color:var(--dr-text-subtle);margin:0 0 var(--dr-space-12)}
.article{max-width:var(--dr-measure)}
.article h1{font:var(--dr-type-display-s);letter-spacing:var(--dr-type-display-s-tracking);color:var(--dr-text-ink);margin:0 0 var(--dr-space-16)}
.article h2{font:var(--dr-type-title);color:var(--dr-text-ink);margin:var(--dr-space-48) 0 var(--dr-space-12)}
.lede{font:var(--dr-type-body-l);color:var(--dr-text-secondary)}
.code{font:var(--dr-type-code);background:var(--dr-surface-sunken);border:var(--dr-stroke-hairline) solid var(--dr-border-rule);border-radius:var(--dr-radius-md);padding:var(--dr-space-16);overflow:auto}
.code:focus-visible{outline:var(--dr-stroke-focus) solid var(--dr-focus-ring)}
.foot{border-top:var(--dr-stroke-hairline) solid var(--dr-border-rule);padding:var(--dr-space-24) var(--dr-gutter);color:var(--dr-text-secondary);font:var(--dr-type-body-s)}
@media (prefers-reduced-motion: no-preference){.next{transition:translate var(--dr-duration-move-base) var(--dr-ease-enter)}.next:hover{translate:var(--dr-distance-enter) 0}}
`;

export const STATUS_CSS = `
body{margin:0;background:var(--dr-surface-ground);color:var(--dr-text-body);font:var(--dr-type-body-m)}
a{color:var(--dr-accent-ink);text-underline-offset:0.2em;transition:color var(--dr-duration-fast) var(--dr-ease-enter)}
a:focus-visible{outline:var(--dr-stroke-focus) solid var(--dr-focus-ring);outline-offset:var(--dr-stroke-focus-offset);border-radius:var(--dr-radius-xs)}
.wrap{max-width:var(--dr-landing);margin:0 auto;padding:var(--dr-space-32) var(--dr-gutter)}
.bar{display:flex;justify-content:space-between;align-items:center;gap:var(--dr-space-16);padding-bottom:var(--dr-space-24);border-bottom:var(--dr-stroke-hairline) solid var(--dr-border-rule)}
.brand{font:var(--dr-type-title);color:var(--dr-text-ink);text-decoration:none}
.headline{font:var(--dr-type-display-s);letter-spacing:var(--dr-type-display-s-tracking);color:var(--dr-text-ink);margin:var(--dr-space-48) 0 var(--dr-space-8)}
.meta{color:var(--dr-text-secondary);font:var(--dr-type-body-s);margin:0}
.parts{list-style:none;margin:var(--dr-space-32) 0 0;padding:0;border-top:var(--dr-stroke-hairline) solid var(--dr-border-rule)}
.part{display:flex;justify-content:space-between;gap:var(--dr-space-16);padding:var(--dr-space-12) 0;border-bottom:var(--dr-stroke-hairline) solid var(--dr-border-rule)}
.state{display:inline-flex;align-items:center;gap:var(--dr-space-8);font:var(--dr-type-body-s)}
.state::before{content:"";width:0.5rem;height:0.5rem;border-radius:var(--dr-radius-full);background:currentColor}
.fresh{color:var(--dr-state-fresh-text)}
.stale{color:var(--dr-state-stale-text)}
.broken{color:var(--dr-state-broken-text)}
.section{font:var(--dr-type-title);color:var(--dr-text-ink);margin:var(--dr-space-48) 0 var(--dr-space-12)}
.updates{list-style:none;margin:0;padding:0}
.update{padding:var(--dr-space-16) 0;border-top:var(--dr-stroke-hairline) solid var(--dr-border-rule)}
.update h3{font:var(--dr-type-body-m);font-weight:var(--dr-weight-strong);color:var(--dr-text-ink);margin:0}
.update p{margin:var(--dr-space-4) 0 0;max-width:var(--dr-measure)}
.foot{margin-top:var(--dr-space-64);color:var(--dr-text-secondary);font:var(--dr-type-body-s)}
`;

const link = (href: string, text: ReactNode, extra: Record<string, string> = {}) =>
  h('a', { href, ...extra }, text);

// A breach fixture adds to a page through these, so every other byte stays the same.
export interface Extras {
  readonly mainClass?: string;
  readonly extra?: ReactNode;
}

export function docsArticle({ mainClass, extra }: Extras = {}): ReactElement {
  const nav = ['Introduction', 'Quickstart', 'Authentication', 'Webhooks', 'Errors', 'Limits'];
  return h(
    'div',
    null,
    link('#content', 'Skip to content', { className: 'skip' }),
    h(
      'header',
      { className: 'bar' },
      link('/docs/', 'Acme docs', { className: 'brand' }),
      h('nav', { 'aria-label': 'Product' }, link('/docs/api', 'API reference')),
    ),
    h(
      'div',
      { className: 'frame' },
      h(
        'nav',
        { className: 'nav', 'aria-label': 'Guides' },
        h('p', { className: 'label' }, 'Guides'),
        h(
          'ul',
          null,
          ...nav.map((name) =>
            h(
              'li',
              { key: name },
              link(
                `/docs/${name.toLowerCase()}`,
                name,
                name === 'Quickstart' ? { 'aria-current': 'page' } : {},
              ),
            ),
          ),
        ),
      ),
      h(
        'main',
        { id: 'content', className: mainClass === undefined ? 'article' : `article ${mainClass}` },
        h('h1', null, 'Quickstart'),
        extra,
        h(
          'p',
          { className: 'lede' },
          'Send your first request in under five minutes. You need an API key and a terminal.',
        ),
        h('h2', { id: 'install' }, 'Install the CLI'),
        h(
          'p',
          null,
          'The CLI signs requests with your key and prints each response as it arrives.',
        ),
        h('pre', { className: 'code', tabIndex: 0 }, h('code', null, 'npm install --global acme')),
        h('h2', { id: 'request' }, 'Make a request'),
        h(
          'p',
          null,
          'Every endpoint answers JSON. Errors carry a stable code, so a client can branch on it ',
          'without reading the message.',
        ),
        h(
          'pre',
          { className: 'code', tabIndex: 0 },
          h('code', null, 'acme get /v1/projects --limit 10'),
        ),
        h('h2', { id: 'next' }, 'Next steps'),
        h(
          'p',
          null,
          'Read about ',
          link('/docs/authentication', 'authentication'),
          ' before you ship, then set up ',
          link('/docs/webhooks', 'webhooks', { className: 'next' }),
          ' to hear about changes.',
        ),
      ),
      h(
        'nav',
        { className: 'toc', 'aria-label': 'On this page' },
        h('p', { className: 'label' }, 'On this page'),
        h(
          'ul',
          null,
          h('li', null, link('#install', 'Install the CLI')),
          h('li', null, link('#request', 'Make a request')),
          h('li', null, link('#next', 'Next steps')),
        ),
      ),
    ),
    h('footer', { className: 'foot' }, 'Acme, built with Drefyn.'),
  );
}

const PARTS: readonly (readonly [string, 'fresh' | 'stale' | 'broken', string])[] = [
  ['API', 'fresh', 'Running'],
  ['Dashboard', 'fresh', 'Running'],
  ['Webhooks', 'stale', 'Degraded'],
  ['Search', 'fresh', 'Running'],
  ['Billing', 'fresh', 'Running'],
];

function statusFrame(children: ReactNode[], { mainClass, extra }: Extras = {}): ReactElement {
  return h(
    'div',
    { className: 'wrap' },
    h(
      'header',
      { className: 'bar' },
      link('/status/', 'Acme status', { className: 'brand' }),
      link('/status/subscribe', 'Subscribe to updates'),
    ),
    h('main', mainClass === undefined ? null : { className: mainClass }, extra, ...children),
    h('footer', { className: 'foot' }, 'Updated 12:00 UTC. Acme, built with Drefyn.'),
  );
}

export function statusHome(extras: Extras = {}): ReactElement {
  return statusFrame(
    [
      h('h1', { key: 'h', className: 'headline' }, 'Webhooks are delayed'),
      h(
        'p',
        { key: 'm', className: 'meta' },
        'Every other part is running. Checked from 5 regions.',
      ),
      h(
        'ul',
        { key: 'p', className: 'parts', 'aria-label': 'Parts' },
        ...PARTS.map(([name, state, word]) =>
          h(
            'li',
            { key: name, className: 'part' },
            h('span', null, name),
            h('span', { className: `state ${state}` }, word),
          ),
        ),
      ),
      h('h2', { key: 's', className: 'section' }, 'Open incident'),
      h(
        'p',
        { key: 'i' },
        link('/status/incident', 'Webhook deliveries are delayed'),
        ', updated 11:52 UTC.',
      ),
    ],
    extras,
  );
}

// Words an on call engineer would use, drawn by a seeded generator so no two updates repeat
// and gzip sees text, not a pattern. A real long incident compresses about this well.
const WORDS = (
  'we are seeing delayed webhook deliveries for some customers in the east region since ' +
  'the deploy at nine retries continue and the queue backlog is shrinking slowly engineers ' +
  'rolled back the consumer build on two hosts after error rates rose sharply one partition ' +
  'still lags by several minutes while others caught up no payloads were lost signing keys ' +
  'were not affected we paused a customer endpoint that kept timing out and will resume it ' +
  'once its owner confirms the fix the index rebuild finished and read latency returned to ' +
  'normal traffic moved away from the slow node in rack four monitoring shows steady progress ' +
  'next update within thirty minutes or sooner if anything changes for the worse dashboard ' +
  'search billing events api gateway replica cluster zone shard lane pool tenant mirror ' +
  'failover drained restarted throttled healthy degraded recovering scheduled cleared'
).split(' ');

function updateText(n: number): string {
  let state = n * 7_919 + 104_729;
  const next = () => {
    state = (state * 48_271) % 2_147_483_647;
    return state;
  };
  const sentences: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const length = 12 + (next() % 9);
    const words: string[] = [];
    for (let w = 0; w < length; w += 1) words.push(WORDS[next() % WORDS.length] ?? 'we');
    const text = words.join(' ');
    sentences.push(`${text.charAt(0).toUpperCase()}${text.slice(1)}.`);
  }
  return sentences.join(' ');
}

const STAGES = ['Investigating', 'Identified', 'Monitoring', 'Resolved'] as const;

export function statusIncident(updates: number): ReactElement {
  const items: ReactElement[] = [];
  for (let n = updates - 1; n >= 0; n -= 1) {
    const minutes = 9 * 60 + n * 7;
    const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    const stage = STAGES[Math.min(STAGES.length - 1, Math.floor((n * STAGES.length) / updates))];
    items.push(
      h(
        'li',
        { key: n, className: 'update' },
        h(
          'h3',
          null,
          `${stage ?? 'Investigating'}, `,
          h('time', { dateTime: `2026-11-05T${time}:00Z` }, `${time} UTC`),
        ),
        h('p', null, updateText(n)),
      ),
    );
  }
  return statusFrame([
    h('h1', { key: 'h', className: 'headline' }, 'Webhook deliveries are delayed'),
    h(
      'p',
      { key: 'm', className: 'meta' },
      h('span', { className: 'state stale' }, 'Degraded'),
      ' Affects webhooks and the events API.',
    ),
    h('h2', { key: 's', className: 'section' }, 'Updates'),
    h('ol', { key: 'u', className: 'updates', reversed: true }, ...items),
  ]);
}
