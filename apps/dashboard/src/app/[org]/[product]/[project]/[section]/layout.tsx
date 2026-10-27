import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { findProject } from '../../../../../fixtures/projects.ts';
import { sectionOf } from '../../../../../shell/sections.ts';

// An unknown section is a 404 status, decided before anything streams.
export default async function SectionLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ product: string; project: string; section: string }>;
}) {
  const { product, project, section } = await params;
  const found = findProject(product, project);
  const entry = found === undefined ? undefined : sectionOf(found.product, section);
  if (entry === undefined || entry.slug === '') notFound();
  return children;
}
