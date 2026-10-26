import { describe, expect, it } from 'vitest';
import {
  ALLOW_LISTS,
  GLOBAL_TABLES,
  PUBLISHED_TABLES,
  READER_FUNCTIONS,
  SECURITY_DEFINER_FUNCTIONS,
  type AllowLists,
} from '../src/allow-lists.ts';
import { allowListProblems, globalTableProblems } from '../src/catalog-check.ts';

const BOOKKEEPING = ['app.pgmigrations', 'app.migration_checksums'];
const REASON = 'migration bookkeeping, owner only, no tenant data';

describe('global table allow list', () => {
  it('holds both bookkeeping tables with the reviewed reason', () => {
    for (const name of BOOKKEEPING) {
      expect(GLOBAL_TABLES, name).toContainEqual({ name, reason: REASON });
    }
  });

  it('passes the bookkeeping tables', () => {
    expect(globalTableProblems(BOOKKEEPING, GLOBAL_TABLES)).toEqual([]);
  });

  it.each(BOOKKEEPING)('fails naming %s once its entry is removed', (removed) => {
    const without = GLOBAL_TABLES.filter((entry) => entry.name !== removed);
    const problems = globalTableProblems(BOOKKEEPING, without);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ rule: 'tenant_column', object: removed });
    expect(problems[0]?.message).toContain(removed);
    expect(problems[0]?.message).toContain('organization_id');
  });

  it('fails on a table that was never listed', () => {
    const problems = globalTableProblems(['app.widgets', ...BOOKKEEPING], GLOBAL_TABLES);
    expect(problems.map((p) => p.object)).toEqual(['app.widgets']);
  });

  it('matches names exactly, not by prefix or case', () => {
    const problems = globalTableProblems(
      ['app.pgmigrations_copy', 'app.PGMIGRATIONS', 'public.pgmigrations'],
      GLOBAL_TABLES,
    );
    expect(problems.map((p) => p.object).sort()).toEqual(
      ['app.PGMIGRATIONS', 'app.pgmigrations_copy', 'public.pgmigrations'].sort(),
    );
  });
});

describe('allow lists', () => {
  it('are themselves clean', () => {
    expect(allowListProblems(ALLOW_LISTS)).toEqual([]);
  });

  it('hold only the two tenant context readers for the reader', () => {
    expect(READER_FUNCTIONS.map((f) => f.name).sort()).toEqual([
      'app.current_org()',
      'app.current_project()',
    ]);
  });

  it('start with no SECURITY DEFINER function and no published table', () => {
    expect(SECURITY_DEFINER_FUNCTIONS).toEqual([]);
    expect(PUBLISHED_TABLES).toEqual([]);
  });

  it.each<[string, (lists: AllowLists) => AllowLists]>([
    [
      'an empty reason',
      (l) => ({ ...l, globalTables: [...l.globalTables, { name: 'app.x', reason: '' }] }),
    ],
    [
      'a blank reason',
      (l) => ({ ...l, publishedTables: [...l.publishedTables, { name: 'app.x', reason: '  ' }] }),
    ],
    [
      'a duplicate entry',
      (l) => ({
        ...l,
        globalTables: [...l.globalTables, { name: 'app.pgmigrations', reason: 'again' }],
      }),
    ],
    [
      'a name outside schema app',
      (l) => ({
        ...l,
        securityDefinerFunctions: [{ name: 'public.f()', reason: 'reviewed' }],
      }),
    ],
    [
      'an unqualified name',
      (l) => ({ ...l, publishedTables: [{ name: 'pages', reason: 'reviewed' }] }),
    ],
  ])('fail on %s', (_label, change) => {
    const problems = allowListProblems(change(ALLOW_LISTS));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((p) => p.rule === 'allow_list')).toBe(true);
  });
});
