import type { PlaceholderProject } from './projects.ts';

export type Freshness = 'fresh' | 'stale' | 'neutral';

export interface DocsPage {
  readonly id: string;
  readonly title: string;
  readonly section: string;
  readonly freshness: Freshness;
  // The date to show, and the machine one behind it.
  readonly edited: string;
  readonly editedOn: string;
  readonly readers: number;
  readonly archived: boolean;
}

// Placeholder rows until the docs API exists. The e2e specs act on them by title.
export const DOCS_PAGES: readonly DocsPage[] = [
  page('introduction', 'Introduction', 'Guides', 'fresh', '12 Oct', '2026-10-12', 1204),
  page('authentication', 'Authentication', 'Guides', 'fresh', '20 Oct', '2026-10-20', 981),
  page('refunds', 'Refunds', 'Guides', 'stale', '3 Sep', '2026-09-03', 642),
  page('create-a-payout', 'Create a payout', 'API reference', 'stale', '18 Aug', '2026-08-18', 518),
  page('webhooks', 'Webhooks overview', 'Guides', 'stale', '1 Sep', '2026-09-01', 433),
  page('list-charges', 'List charges', 'API reference', 'fresh', '24 Oct', '2026-10-24', 402),
  page('errors', 'Errors', 'Reference', 'fresh', '2 Oct', '2026-10-02', 377),
  page('idempotency', 'Idempotency', 'Guides', 'fresh', '9 Oct', '2026-10-09', 210),
  page('changelog', 'Changelog', 'Reference', 'neutral', '4 Jun', '2026-06-04', 12),
];

function page(
  id: string,
  title: string,
  section: string,
  freshness: Freshness,
  edited: string,
  editedOn: string,
  readers: number,
): DocsPage {
  return { id, title, section, freshness, edited, editedOn, readers, archived: false };
}

// Only this project has a working Pages view. The rest wait for their product.
const WITH_PAGES = 'payments-api';

export const docsPagesOf = (project: PlaceholderProject): readonly DocsPage[] | undefined =>
  project.slug === WITH_PAGES ? DOCS_PAGES : undefined;
