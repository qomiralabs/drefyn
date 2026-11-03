import { describe, expect, it } from 'vitest';
import { allowListProblems, egressAllowList } from '../src/index.ts';

const FETCH = [{ global: 'fetch' }] as const;

describe('egress allow list schema', () => {
  it('finds nothing wrong with the shared list', () => {
    expect(allowListProblems(egressAllowList)).toEqual([]);
  });

  it('refuses an entry with only that names a directory', () => {
    expect(
      allowListProblems([
        { path: 'packages/auth/src/', reason: 'r', only: FETCH },
        { path: 'packages/auth/src', reason: 'r', only: FETCH },
      ]),
    ).toEqual([
      "allow list entry 'packages/auth/src/': an entry with only must name one source file, not a directory",
      "allow list entry 'packages/auth/src': an entry with only must name one source file, not a directory",
    ]);
  });

  it('refuses an entry under apps/ without only', () => {
    expect(
      allowListProblems([
        { path: 'apps/dashboard/server.ts', reason: 'r' },
        { path: 'apps/', reason: 'r' },
        { path: 'apps', reason: 'r' },
      ]),
    ).toEqual([
      "allow list entry 'apps/dashboard/server.ts': entries under apps/ must list the forms they need in only",
      "allow list entry 'apps/': entries under apps/ must list the forms they need in only",
      "allow list entry 'apps': entries under apps/ must list the forms they need in only",
    ]);
  });

  it('accepts scoped file entries anywhere and whole file entries outside apps/', () => {
    expect(
      allowListProblems([
        { path: 'apps/dashboard/server.ts', reason: 'r', only: FETCH },
        { path: 'packages/auth/src/oauth-fetch.mts', reason: 'r', only: FETCH },
        { path: 'scripts/tool/vendor/', reason: 'r' },
        { path: 'appsx/thing.ts', reason: 'r' },
      ]),
    ).toEqual([]);
  });
});
