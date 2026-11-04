import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSlug } from '@drefyn/auth';
import { describe, expect, it } from 'vitest';
import { parseShellPath } from '../src/shell/route.ts';
import { appRoutes } from './support/app-routes.ts';

// Next prefers a real folder to [org], so an organization with a route's name could never be
// opened. Read from src/app, so a new route that nobody reserved fails here.
const routes = appRoutes(new URL('../src/app/', import.meta.url).pathname);

describe('top level routes', () => {
  it('finds them, groups and [org] left out', () => {
    expect(routes).toEqual(expect.arrayContaining(['bundle-baseline', 'sign-in', 'welcome']));
    expect(routes).not.toContain('[org]');
  });

  it('reaches routes inside group folders and parallel slots', () => {
    const app = mkdtempSync(join(tmpdir(), 'routes-'));
    try {
      for (const path of ['plain', '(group)/inner', '(a)/(b)/deep', '@slot/held', '[org]/x']) {
        mkdirSync(join(app, path), { recursive: true });
      }
      mkdirSync(join(app, '_private'));
      expect(appRoutes(app).toSorted()).toEqual(['deep', 'held', 'inner', 'plain']);
    } finally {
      rmSync(app, { recursive: true });
    }
  });

  it.each(routes)('%s cannot be taken as a slug', (route) => {
    expect(parseSlug(route).ok).toBe(false);
  });

  it.each(routes)('%s is no shell path', (route) => {
    expect(parseShellPath(`/${route}`)).toBeNull();
  });
});
