import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { guardOrganization } from '../../../../../server/guard.ts';
import { findProject } from '../../../../../server/projects.ts';
import { sectionOf } from '../../../../../shell/sections.ts';

// An unknown section is a 404 status, decided before anything streams.
export default async function SectionLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ org: string; product: string; project: string; section: string }>;
}) {
  const { org, product, project, section } = await params;
  const { access } = await guardOrganization(org);
  const found = await findProject(access, product, project);
  const entry = found === undefined ? undefined : sectionOf(found.product, section);
  if (entry === undefined || entry.slug === '') notFound();
  return children;
}
