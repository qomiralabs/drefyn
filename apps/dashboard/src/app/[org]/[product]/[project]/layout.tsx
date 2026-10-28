import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { findProject } from '../../../../fixtures/projects.ts';
import { guardOrganization } from '../../../../server/guard.ts';
import { parseShellPath } from '../../../../shell/route.ts';

// Checked here, above the loading boundary, so an unknown project is a real 404 status and
// not a 404 page streamed after a 200.
export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ org: string; product: string; project: string }>;
}) {
  const { org, product, project } = await params;
  await guardOrganization(org);
  const location = parseShellPath(`/${org}/${product}/${project}`);
  if (location?.project === undefined || findProject(product, location.project) === undefined) {
    notFound();
  }
  return children;
}
