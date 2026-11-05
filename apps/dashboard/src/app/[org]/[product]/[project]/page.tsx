import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { guardOrganization } from '../../../../server/guard.ts';
import { findProject } from '../../../../server/projects.ts';
import { parseShellPath } from '../../../../shell/route.ts';
import { ProjectHomeEmpty } from '../../../../views/project-home.tsx';

interface Params {
  params: Promise<{ org: string; product: string; project: string }>;
}

async function projectFrom(params: Params['params']) {
  const { org, product, project } = await params;
  const { access } = await guardOrganization(org);
  const location = parseShellPath(`/${org}/${product}/${project}`);
  const found =
    location?.project === undefined
      ? undefined
      : await findProject(access, product, location.project);
  if (found === undefined) notFound();
  return found;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  return { title: (await projectFrom(params)).name };
}

export default async function ProjectHome({ params }: Params) {
  const project = await projectFrom(params);
  const { org } = await params;
  return <ProjectHomeEmpty org={org} project={project} />;
}
