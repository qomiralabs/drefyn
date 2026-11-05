import { describe, expect, it } from 'vitest';
import { pagesFrom } from '../src/docs-pages/client.ts';
import { DOCS_PAGES } from '../src/fixtures/pages.ts';
import { OptimisticRefused } from '../src/optimistic/store.ts';

describe('pagesFrom', () => {
  it('gives back the pages the server answered with', () => {
    expect(pagesFrom({ ok: true, pages: DOCS_PAGES })).toBe(DOCS_PAGES);
  });

  it('turns a refusal into one the store can log by its code', () => {
    let failure: unknown;
    try {
      pagesFrom({ ok: false, code: 'pages.unknown_page' });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OptimisticRefused);
    expect((failure as OptimisticRefused).code).toBe('pages.unknown_page');
  });
});
