import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  PRODUCTS,
  RESERVED_SLUGS,
  parseShellPath,
  productHref,
  shellHref,
  type ShellLocation,
} from '../src/index.ts';
import { sectionHref } from '../src/shell/route.ts';
import { SEEDS } from './seeds.ts';

// fc.webPath() takes a few hundred ms to construct, more on a loaded CI runner. Built once here so
// collection pays for it, not whichever seed happens to run first.
const anyPath = fc.oneof(fc.string(), fc.webPath(), fc.string({ unit: 'binary' }));

describe('product labels', () => {
  it('are the short names, in suite order', () => {
    expect(PRODUCTS.map((p) => [p.id, p.label])).toEqual([
      ['docs', 'Docs'],
      ['studio', 'Studio'],
      ['status', 'Status'],
    ]);
  });
});

describe('parseShellPath', () => {
  it.each<[string, ShellLocation]>([
    ['/acme', { org: 'acme' }],
    ['/acme/', { org: 'acme' }],
    ['/acme/docs', { org: 'acme', product: 'docs' }],
    ['/acme/status', { org: 'acme', product: 'status' }],
    ['/acme/docs/payments-api', { org: 'acme', product: 'docs', project: 'payments-api' }],
    [
      '/acme/docs/payments-api/pages',
      { org: 'acme', product: 'docs', project: 'payments-api', section: 'pages' },
    ],
    [
      '/acme/status/acme-status/incidents/inc-1',
      {
        org: 'acme',
        product: 'status',
        project: 'acme-status',
        section: 'incidents',
        item: 'inc-1',
      },
    ],
  ])('reads %s', (path, location) => {
    expect(parseShellPath(path)).toEqual(location);
  });

  it.each([
    ['', 'empty'],
    ['/', 'no organization'],
    ['acme/docs', 'not absolute'],
    ['/acme/blog', 'unknown product'],
    ['/acme/Docs', 'product is case sensitive'],
    ['/Acme', 'slugs are lower case'],
    ['/acme/docs/-x', 'slug starts with a hyphen'],
    ['/acme/docs/x-', 'slug ends with a hyphen'],
    ['/acme//docs', 'empty segment'],
    ['/acme/docs/a/b/c', 'deeper than a section'],
    ['/acme/status/a/pages/c', 'only incidents have items'],
    ['/acme/docs/a/incidents/c', 'incidents belong to Status'],
    ['/acme/status/a/incidents/b/c', 'deeper than an item'],
    ['/acme/docs/%2e%2e', 'encoded dot segment'],
    ['/acme/docs/..', 'dot segment'],
    ['/acme?x=1', 'query is not part of a pathname'],
    [`/${'a'.repeat(64)}`, 'slug longer than 63'],
    ['/bundle-baseline', 'reserved slug'],
    ['/api', 'reserved slug'],
    ['/api/docs', 'reserved slug with a product'],
  ])('refuses %j (%s)', (path) => {
    expect(parseShellPath(path)).toBeNull();
  });

  it('reads the state gallery like a project, and only below a product', () => {
    expect(parseShellPath('/shell-states/docs/payments-api')).toEqual({
      org: 'shell-states',
      product: 'docs',
      project: 'payments-api',
    });
    expect(parseShellPath('/shell-states')).toBeNull();
    expect(parseShellPath('/settings-states/docs/x')).toBeNull();
  });

  it('reserves the bundle baseline route so no organization can shadow it', () => {
    expect(RESERVED_SLUGS).toContain('bundle-baseline');
    expect(RESERVED_SLUGS).toContain('api');
  });

  const slug = fc
    .stringMatching(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
    .filter((s) => !RESERVED_SLUGS.includes(s));
  const location: fc.Arbitrary<ShellLocation> = fc.oneof(
    fc.record({ org: slug }),
    fc.record({ org: slug, product: fc.constantFrom(...PRODUCTS.map((p) => p.id)) }),
    fc.record({
      org: slug,
      product: fc.constantFrom(...PRODUCTS.map((p) => p.id)),
      project: slug,
    }),
    fc.record({
      org: slug,
      product: fc.constantFrom(...PRODUCTS.map((p) => p.id)),
      project: slug,
      section: slug,
    }),
    fc.record({
      org: slug,
      product: fc.constant('status' as const),
      project: slug,
      section: fc.constant('incidents'),
      item: slug,
    }),
  );

  it.each(SEEDS)('round trips every valid location through its href (seed %i)', (seed) => {
    fc.assert(
      fc.property(location, (loc) => {
        expect(parseShellPath(shellHref(loc))).toEqual(loc);
      }),
      { seed, numRuns: 300 },
    );
  });

  it.each(SEEDS)('never throws on any string (seed %i)', (seed) => {
    fc.assert(
      fc.property(anyPath, (path) => {
        const parsed = parseShellPath(path);
        if (parsed !== null) expect(shellHref(parsed)).toBe(path.replace(/\/$/, ''));
      }),
      { seed, numRuns: 500 },
    );
  });
});

describe('sectionHref', () => {
  it('drops an item, so the sidebar can mark the section it sits under', () => {
    const here: ShellLocation = {
      org: 'acme',
      product: 'status',
      project: 'acme-status',
      section: 'incidents',
      item: 'inc-1',
    };
    expect(sectionHref(here)).toBe('/acme/status/acme-status/incidents');
    expect(sectionHref({ org: 'acme', product: 'docs' })).toBe('/acme/docs');
  });
});

describe('productHref', () => {
  it('keeps the organization and opens the product home', () => {
    const here: ShellLocation = { org: 'acme', product: 'docs', project: 'payments-api' };
    expect(productHref(here, 'docs')).toBe('/acme/docs');
    expect(productHref(here, 'studio')).toBe('/acme/studio');
    expect(productHref(here, 'status')).toBe('/acme/status');
    expect(productHref({ org: 'northwind' }, 'status')).toBe('/northwind/status');
  });
});

describe('paths the first run pages own', () => {
  it.each(['/welcome', '/organizations', '/organizations/new'])('%s is no shell path', (path) => {
    expect(parseShellPath(path)).toBeNull();
  });
});

describe('paths the signed out pages own', () => {
  it.each(['sign-in', 'sign-up', 'sign-out', 'invite', 'auth'])('%s is no organization', (slug) => {
    expect(parseShellPath(`/${slug}`)).toBeNull();
    expect(parseShellPath(`/${slug}/docs`)).toBeNull();
  });
});
