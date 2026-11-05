import type { AccessContext, Permission } from '@drefyn/auth';
import { describe, expect, it } from 'vitest';
import { docsPagesOf, DOCS_PAGES } from '../src/fixtures/pages.ts';
import { findProject } from '../src/fixtures/projects.ts';
import { updatePages } from '../src/server/pages-fixture.ts';

const access = (permissions: readonly Permission[] = ['docs.read']): AccessContext =>
  ({ permissions }) as unknown as AccessContext;

const project = (slug: string) => findProject(access(), 'docs', slug);

const body = (overrides: object = {}) => ({
  project: 'payments-api',
  pages: [{ id: 'refunds', archived: true }],
  ...overrides,
});

describe('placeholder pages', () => {
  it('belong to the one project with a working Pages view', () => {
    const payments = project('payments-api');
    expect(payments === undefined ? [] : docsPagesOf(payments)).toEqual(DOCS_PAGES);
  });

  it.each(['new-docs', 'unreachable', 'pending'])('%s has none', (slug) => {
    const found = project(slug);
    expect(found === undefined ? 'missing' : docsPagesOf(found)).toBeUndefined();
  });

  it('start out with nothing archived, with unique ids', () => {
    expect(DOCS_PAGES.every((p) => !p.archived)).toBe(true);
    expect(new Set(DOCS_PAGES.map((p) => p.id)).size).toBe(DOCS_PAGES.length);
  });
});

describe('the fixture server', () => {
  it('answers with the pages as they now stand', () => {
    expect(updatePages(access(), body())).toEqual({
      ok: true,
      pages: [{ ...DOCS_PAGES.find((p) => p.id === 'refunds'), archived: true }],
    });
  });

  it('restores as well as archives', () => {
    const answer = updatePages(access(), body({ pages: [{ id: 'refunds', archived: false }] }));
    expect(answer).toMatchObject({ ok: true, pages: [{ id: 'refunds', archived: false }] });
  });

  it.each([
    ['nothing', undefined],
    ['a string', 'refunds'],
    ['no pages', { project: 'payments-api', pages: [] }],
    ['too many pages', body({ pages: Array.from({ length: 51 }, () => DOCS_PAGES[0]) })],
    ['a bad flag', body({ pages: [{ id: 'refunds', archived: 'yes' }] })],
    ['an odd key', body({ extra: true })],
  ])('refuses %s', (_name, input) => {
    expect(updatePages(access(), input)).toEqual({ ok: false, code: 'pages.input_invalid' });
  });

  it('refuses a page the project does not hold', () => {
    const answer = updatePages(access(), body({ pages: [{ id: 'nope', archived: true }] }));
    expect(answer).toEqual({ ok: false, code: 'pages.unknown_page' });
  });

  it.each(['new-docs', 'unreachable', 'acme-status', 'missing'])(
    'refuses %s, which has no pages to change',
    (slug) => {
      const answer = updatePages(access(), body({ project: slug }));
      expect(answer).toEqual({ ok: false, code: 'pages.not_found' });
    },
  );

  it('treats someone who may not read Docs as if the project were not there', () => {
    const answer = updatePages(access(['status.read']), body());
    expect(answer).toEqual({ ok: false, code: 'pages.not_found' });
  });
});
