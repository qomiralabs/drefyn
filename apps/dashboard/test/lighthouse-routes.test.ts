import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOT_SHELL_ROUTES, pathMatchesRoute, SHELL_ROUTES } from '../e2e/lighthouse-routes.ts';

// Folders that add nothing to the URL, which never sit in a page route's path.
const silent = (part: string) => /^[(@]/.test(part);

function pageRoutes(app: string): readonly string[] {
  return readdirSync(app, { recursive: true, encoding: 'utf8' })
    .filter((file) => /(^|[\\/])page\.tsx$/.test(file))
    .map((file) => {
      const parts = relative(app, join(app, file)).split(sep).slice(0, -1);
      return `/${parts.filter((part) => !silent(part)).join('/')}`;
    });
}

const unlisted = (routes: readonly string[]) =>
  routes.filter((route) => !(route in SHELL_ROUTES) && !(route in NOT_SHELL_ROUTES));

const routes = pageRoutes(new URL('../src/app/', import.meta.url).pathname);

describe('the Lighthouse run list', () => {
  it('reads the real tree', () => {
    expect(routes).toEqual(expect.arrayContaining(['/', '/[org]', '/account/sessions']));
  });

  it('names every page route', () => {
    expect(unlisted(routes)).toEqual([]);
  });

  it('lists no route that is gone', () => {
    const listed = [...Object.keys(SHELL_ROUTES), ...Object.keys(NOT_SHELL_ROUTES)];
    expect(listed.filter((route) => !routes.includes(route))).toEqual([]);
  });

  it('never puts a route on both sides', () => {
    expect(Object.keys(SHELL_ROUTES).filter((route) => route in NOT_SHELL_ROUTES)).toEqual([]);
  });

  it.each(Object.entries(SHELL_ROUTES))('%s has paths that really draw it', (route, paths) => {
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(pathMatchesRoute(path, route), path).toBe(true);
  });

  it('fails on a new page nobody listed, wherever it sits', () => {
    const app = mkdtempSync(join(tmpdir(), 'routes-'));
    try {
      for (const folder of ['account', '[org]/reports', '(group)/inner']) {
        mkdirSync(join(app, folder), { recursive: true });
        writeFileSync(join(app, folder, 'page.tsx'), '');
      }
      expect(unlisted(pageRoutes(app)).toSorted()).toEqual(['/[org]/reports', '/inner']);
    } finally {
      rmSync(app, { recursive: true });
    }
  });
});

describe('matching a path to its route', () => {
  it.each([
    ['/acme', '/[org]', true],
    ['/acme/docs', '/[org]', false],
    ['/acme/settings/plan', '/[org]/settings/[page]', true],
    ['/account', '/account', true],
    ['/shell-states/docs/a', '/shell-states/[product]/[project]/[[...section]]', true],
    ['/shell-states/docs/a/pages', '/shell-states/[product]/[project]/[[...section]]', true],
    ['/shell-states/docs', '/shell-states/[product]/[project]/[[...section]]', false],
  ])('%s against %s is %s', (path, route, expected) => {
    expect(pathMatchesRoute(path, route)).toBe(expected);
  });
});
