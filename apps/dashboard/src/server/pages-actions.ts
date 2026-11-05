'use server';
import { orgAction } from './actions.ts';
import { pagesAreOpen, updatePages, type PagesAnswer } from './pages-fixture.ts';

// Replaced by the docs API when it exists. The flag, origin and membership checks are the
// wrapper's, so with the dashboard off this answers like everything else: a 404. Only the
// state gallery calls it, so an ordinary install refuses it as well.
export const writePages = orgAction(({ access }, input: unknown): Promise<PagesAnswer> => {
  if (!pagesAreOpen(process.env)) return Promise.resolve({ ok: false, code: 'pages.not_found' });
  return Promise.resolve(updatePages(access, input));
});
