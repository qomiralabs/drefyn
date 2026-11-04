import { readdirSync } from 'node:fs';
import { parseSlug } from '@drefyn/auth';
import { describe, expect, it } from 'vitest';
import { parseShellPath } from '../src/shell/route.ts';

// Next prefers a real folder to [org], so an organization with a route's name could never be
// opened. Read from src/app, so a new route that nobody reserved fails here.
const ROUTE_NAME = /^[^[(@_]/;
const routes = readdirSync(new URL('../src/app/', import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && ROUTE_NAME.test(entry.name))
  .map((entry) => entry.name);

describe('top level routes', () => {
  it('finds them, groups and [org] left out', () => {
    expect(routes).toEqual(expect.arrayContaining(['bundle-baseline', 'sign-in', 'welcome']));
    expect(routes).not.toContain('[org]');
  });

  it.each(routes)('%s cannot be taken as a slug', (route) => {
    expect(parseSlug(route).ok).toBe(false);
  });

  it.each(routes)('%s is no shell path', (route) => {
    expect(parseShellPath(`/${route}`)).toBeNull();
  });
});
