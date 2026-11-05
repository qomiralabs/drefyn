import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderDocsPage, renderKey, renderStatusPage } from '../src/index.ts';
import { incompressible, pageInput, tenant } from './fixtures.ts';

const SECRET = 'private launch notes maya@acme.dev';

function capture() {
  const lines: [string, Readonly<Record<string, string | number | boolean>>][] = [];
  return {
    lines,
    log: {
      warn: (event: string, fields: Readonly<Record<string, string | number | boolean>>) =>
        lines.push([event, fields]),
    },
  };
}

const page = (body: ReturnType<typeof createElement>) =>
  new Map([[`/${SECRET}`, { title: SECRET, description: SECRET, body }]]);

const Boom = () => {
  throw new Error(SECRET);
};

describe('site logs', () => {
  it.each([
    [
      'site.render_failed',
      () => renderDocsPage,
      pageInput({ route: `/${SECRET}` }, { pages: page(createElement(Boom)) }),
    ],
    ['site.unknown_route', () => renderDocsPage, pageInput({ route: `/${SECRET}` })],
    [
      'site.budget_exceeded',
      () => renderStatusPage,
      pageInput(
        { route: `/${SECRET}` },
        { pages: page(createElement('p', null, SECRET, incompressible(40_000))) },
      ),
    ],
    [
      'site.first_response_over_target',
      () => renderStatusPage,
      pageInput(
        { route: `/${SECRET}` },
        { pages: page(createElement('p', null, SECRET, incompressible(19_000))) },
      ),
    ],
  ])('%s carries ids and never content', (event, pick, input) => {
    const { lines, log } = capture();
    pick()(input, { log });
    expect(lines.map(([name]) => name)).toEqual([event]);
    const fields = lines[0]?.[1];
    expect(fields).toMatchObject({
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
    });
    expect(fields?.['key']).toBe(renderKey(pick() === renderDocsPage ? 'docs' : 'status', input));
    expect(JSON.stringify(lines)).not.toContain('private');
    expect(JSON.stringify(lines)).not.toContain('maya');
  });

  it('logs nothing it cannot tie to a tenant', () => {
    const { lines, log } = capture();
    renderDocsPage(pageInput({ tenant: { organizationId: 'x', projectId: 'y' } as never }), {
      log,
    });
    expect(lines).toEqual([]);
  });

  it('renders the same bytes with and without a logger', () => {
    expect(renderDocsPage(pageInput(), { log: capture().log })).toEqual(
      renderDocsPage(pageInput()),
    );
  });
});
