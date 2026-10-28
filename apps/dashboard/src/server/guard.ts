import { notFound } from 'next/navigation';
import { cache } from 'react';
import { PLACEHOLDER } from '../fixtures/placeholder.ts';
import { parseShellPath } from '../shell/route.ts';
import { requireDashboard } from './gate.ts';

// Next renders a page and its generateMetadata alongside their layouts, so a check in the
// layout alone still streams the page. Every page and every generateMetadata awaits this
// first. An unknown organization is refused before the flag is even read. Cached per request,
// so the flag client is asked once however many callers there are.
export const guardOrganization = cache(async (org: string) => {
  if (parseShellPath(`/${org}`) === null || org !== PLACEHOLDER.organization.slug) notFound();
  await requireDashboard(PLACEHOLDER.organization.id);
  return PLACEHOLDER.organization;
});
