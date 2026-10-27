import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { findProject } from '../../../../../fixtures/projects.ts';
import { parseShellPath } from '../../../../../shell/route.ts';
import { sectionOf } from '../../../../../shell/sections.ts';
import { Working } from '../../../../../views/working.tsx';

interface Params {
  params: Promise<{ org: string; product: string; project: string; section: string }>;
}

async function load(params: Params['params']) {
  const { org, product, project, section } = await params;
  const location = parseShellPath(`/${org}/${product}/${project}/${section}`);
  const found =
    location?.product === undefined || location.project === undefined
      ? undefined
      : findProject(location.product, location.project);
  const entry =
    found === undefined || location?.section === undefined
      ? undefined
      : sectionOf(found.product, location.section);
  if (found === undefined || entry === undefined || entry.slug === '') notFound();
  return { project: found, section: entry };
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { project, section } = await load(params);
  return { title: `${section.label}, ${project.name}` };
}

// Working views arrive with their products; the shell only gives them a place.
export default async function SectionPage({ params }: Params) {
  const { project, section } = await load(params);
  return (
    <Working title={section.label} caption={`${section.label} in ${project.name}`}>
      <p className="max-w-measure text-body-s text-secondary">
        This view arrives with the product. Everything else in the shell works around it.
      </p>
    </Working>
  );
}
