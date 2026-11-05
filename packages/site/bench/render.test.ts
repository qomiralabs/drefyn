import { createElement } from 'react';
import { Badge, StatusDot } from '@drefyn/ui/react';
import { expect, it } from 'vitest';
import { organizationId, projectId } from '@drefyn/tenancy';
import { renderDocsPage, renderStatusPage, type SitePageData } from '../src/index.ts';

const RUNS = 4_000;
const WARMUP = 500;
const BUDGET_MS = 5;

const tenant = {
  organizationId: organizationId('00000000-0000-4000-8000-000000000001'),
  projectId: projectId('00000000-0000-4000-8000-000000000002'),
};

// About the #75 status page: twenty components and three incidents.
const body = createElement(
  'main',
  { className: 'page' },
  ...Array.from({ length: 20 }, (_, i) =>
    createElement(
      'section',
      { key: i, className: 'row' },
      createElement('h2', null, `Component ${i}`),
      createElement(StatusDot, { state: 'fresh', children: 'Running' }),
      createElement(Badge, { state: 'fresh', children: 'Running' }),
      createElement('p', null, 'The retrieval API answered within its usual time for all regions.'),
    ),
  ),
);

const data: SitePageData = {
  version: 'ver-1',
  builtAt: '2026-11-05T12:00:00.000Z',
  css: Array.from({ length: 200 }, (_, i) => `.u${i}{margin:var(--dr-space-${i % 8})}`).join(''),
  scripts: [{ kind: 'script', href: '/assets/page.js', gzipBytes: 4_100 }],
  pages: new Map([['/', { title: 'Acme status', description: 'Live state.', body }]]),
};

const input = {
  tenant,
  route: '/',
  locale: 'en',
  theme: {},
  policy: { version: 1, maxFirstResponseBytes: 14_000 },
  data,
};

it.each([
  ['docs', renderDocsPage],
  ['status', renderStatusPage],
] as const)('%s render stays under 5 ms at p99', (surface, render) => {
  const times: number[] = [];
  for (let i = 0; i < RUNS + WARMUP; i += 1) {
    const start = performance.now();
    const result = render(input);
    const took = performance.now() - start;
    expect(result.ok).toBe(true);
    if (i >= WARMUP) times.push(took);
  }
  times.sort((a, b) => a - b);
  const at = (p: number) => times[Math.floor(times.length * p)] ?? Number.NaN;
  process.stdout.write(
    `${surface}: p50 ${at(0.5).toFixed(2)} ms, p99 ${at(0.99).toFixed(2)} ms, ${RUNS} runs\n`,
  );
  expect(at(0.99)).toBeLessThan(BUDGET_MS);
});
