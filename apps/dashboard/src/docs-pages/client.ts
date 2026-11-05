import type { DocsPage } from '../fixtures/pages.ts';
import { OptimisticRefused } from '../optimistic/store.ts';

// Both the fixture's refusals and the action wrapper's arrive with this shape.
export type PagesReply =
  | { readonly ok: true; readonly pages: readonly DocsPage[] }
  | { readonly ok: false; readonly code: string };

export function pagesFrom(reply: PagesReply): readonly DocsPage[] {
  if (!reply.ok) throw new OptimisticRefused(reply.code);
  return reply.pages;
}
