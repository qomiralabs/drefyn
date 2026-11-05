'use server';
import { orgAction } from './actions.ts';
import { updatePages } from './pages-fixture.ts';

// Replaced by the docs API when it exists. The flag, origin and membership checks are the
// wrapper's, so with the dashboard off this answers like everything else: a 404.
export const writePages = orgAction(({ access }, input: unknown) =>
  Promise.resolve(updatePages(access, input)),
);
