// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolvedPaths, workspaceListing } from './single-react.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');

// Two copies of React break hooks at run time with an error that names neither copy.
describe('one React across the workspace', () => {
  it('finds both copies in a listing with two', () => {
    const listing: unknown = JSON.parse(
      readFileSync(join(here, '..', 'fixtures', 'pnpm-list-two-react.json'), 'utf8'),
    );
    expect(resolvedPaths(listing, 'react')).toEqual([
      '/repo/node_modules/.pnpm/react@18.3.1/node_modules/react',
      '/repo/node_modules/.pnpm/react@19.3.1/node_modules/react',
    ]);
  });

  it('ignores entries with no path and projects that are not objects', () => {
    expect(
      resolvedPaths([null, { dependencies: { react: { version: '19.3.1' } } }], 'react'),
    ).toEqual([]);
  });

  for (const name of ['react', 'react-dom']) {
    it(`resolves exactly one ${name}`, { timeout: 60_000 }, () => {
      const paths = resolvedPaths(workspaceListing(repo, name), name);
      expect(paths).toHaveLength(1);
      expect(paths[0]).toContain(`${name}@19.3.1`);
    });
  }
});
