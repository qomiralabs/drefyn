import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PagesTable } from '../../../../../docs-pages/pages-table.tsx';
import { docsPagesOf } from '../../../../../fixtures/pages.ts';
import { findProject } from '../../../../../fixtures/projects.ts';
import { guardOrganization } from '../../../../../server/guard.ts';
import { parseShellPath } from '../../../../../shell/route.ts';
import { sectionOf } from '../../../../../shell/sections.ts';
import { Working } from '../../../../../views/working.tsx';

interface Params {
  params: Promise<{ org: string; product: string; project: string; section: string }>;
}

async function load(params: Params['params']) {
  const { org, product, project, section } = await params;
  const { access } = await guardOrganization(org);
  const location = parseShellPath(`/${org}/${product}/${project}/${section}`);
  const found =
    location?.product === undefined || location.project === undefined
      ? undefined
      : findProject(access, location.product, location.project);
  const entry =
    found === undefined || location?.section === undefined
      ? undefined
      : sectionOf(found.product, location.section);
  if (found === undefined || entry === undefined || entry.slug === '') notFound();
  return { access, org, project: found, section: entry };
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { project, section } = await load(params);
  return { title: `${section.label}, ${project.name}` };
}

// Working views arrive with their products; the shell only gives them a place.
export default async function SectionPage({ params }: Params) {
  const { access, org, project, section } = await load(params);
  const pages = section.slug === 'pages' ? docsPagesOf(project) : undefined;
  return (
    <Working title={section.label} caption={`${section.label} in ${project.name}`}>
      {pages === undefined ? (
        <p className="max-w-measure text-body-s text-secondary">
          This view arrives with the product. Everything else in the shell works around it.
        </p>
      ) : (
        <PagesTable
          org={org}
          project={project.slug}
          pages={pages}
          tenant={{ organizationId: access.organizationId, projectId: project.id }}
        />
      )}
    </Working>
  );
}
