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
    ['/acme/docs/%2e%2e', 'encoded dot segment'],
    ['/acme/docs/..', 'dot segment'],
    ['/acme?x=1', 'query is not part of a pathname'],
    [`/${'a'.repeat(64)}`, 'slug longer than 63'],
    ['/bundle-baseline', 'reserved slug'],
  ])('refuses %j (%s)', (path) => {
    expect(parseShellPath(path)).toBeNull();
  });

  it('reserves the bundle baseline route so no organization can shadow it', () => {
    expect(RESERVED_SLUGS).toContain('bundle-baseline');
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

describe('productHref', () => {
  it('keeps the organization and opens the product home', () => {
    const here: ShellLocation = { org: 'acme', product: 'docs', project: 'payments-api' };
    expect(productHref(here, 'docs')).toBe('/acme/docs');
    expect(productHref(here, 'studio')).toBe('/acme/studio');
    expect(productHref(here, 'status')).toBe('/acme/status');
    expect(productHref({ org: 'northwind' }, 'status')).toBe('/northwind/status');
  });
});
