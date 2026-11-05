import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { PagesTable } from '../../../../../docs-pages/pages-table.tsx';
import { docsPagesOf } from '../../../../../fixtures/pages.ts';
import { ProjectBody } from '../../../../../fixtures/project-states.tsx';
import { PLACEHOLDER } from '../../../../../fixtures/placeholder.ts';
import { PLACEHOLDER_SHELL } from '../../../../../fixtures/shell.ts';
import { findProject } from '../../../../../fixtures/projects.ts';
import { guardPublic } from '../../../../../server/guard.ts';
import { MainBusy } from '../../../../../views/main-busy.tsx';
import { ProjectLoading } from '../../../../../views/project-loading.tsx';
import { ShellChrome } from '../../../../../views/shell-chrome.tsx';
import { WaitsInBrowser } from '../../../../../views/waits-in-browser.tsx';
import { Working } from '../../../../../views/working.tsx';
import type { AccessContext } from '@drefyn/auth';

interface Props {
  readonly params: Promise<{
    readonly product: string;
    readonly project: string;
    readonly section?: readonly string[];
  }>;
}

const PERMISSIONS = [
  'org.read',
  'org.manage_members',
  'org.manage_api_keys',
  'docs.read',
  'studio.read',
  'status.read',
] as const;
const READER = { permissions: PERMISSIONS } as unknown as AccessContext;

export async function generateMetadata(): Promise<Metadata> {
  await guardPublic();
  return { title: 'Shell states' };
}

// What no product feeds yet, from fixed words, for the visual, axe and undo specs. A server
// opts in, so an ordinary install answers 404, and the flag still decides first.
export default async function ShellState({ params }: Props) {
  await guardPublic();
  if (process.env['DREFYN_DASHBOARD_STATES'] !== 'on') notFound();
  const { product, project: slug, section = [] } = await params;
  const project = findProject(READER, product, slug);
  const pages = project === undefined ? undefined : docsPagesOf(project);
  if (project === undefined || section.length > 1) notFound();
  if (section.length === 1 && (section[0] !== 'pages' || pages === undefined)) notFound();
  const org = PLACEHOLDER.organization.slug;
  const tenant = { organizationId: PLACEHOLDER.organization.id, projectId: project.id };
  return (
    <ShellChrome data={PLACEHOLDER_SHELL} permissions={PERMISSIONS}>
      {section.length === 1 && pages !== undefined ? (
        <Working title="Pages" caption={`Pages in ${project.name}`}>
          <PagesTable org={org} project={project.slug} pages={pages} tenant={tenant} />
        </Working>
      ) : (
        <>
          <MainBusy busy />
          <Suspense fallback={<ProjectLoading name={project.name} />}>
            {project.slug === 'pending' ? (
              // The loading state, seen and tested: same skeleton, and main stays busy.
              <>
                <ProjectLoading name={project.name} />
                <WaitsInBrowser />
              </>
            ) : (
              <>
                <MainBusy busy={false} />
                <ProjectBody org={org} project={project} />
              </>
            )}
          </Suspense>
        </>
      )}
    </ShellChrome>
  );
}
