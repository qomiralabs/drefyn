import { Badge, ButtonLink, StatusPip } from '@drefyn/ui/react';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { findProject, type PlaceholderProject } from '../../../../fixtures/projects.ts';
import { PLACEHOLDER } from '../../../../fixtures/placeholder.ts';
import { requireDashboard } from '../../../../server/gate.ts';
import { parseShellPath, shellHref } from '../../../../shell/route.ts';
import { MainBusy } from '../../../../views/main-busy.tsx';
import { ProjectLoading } from '../../../../views/project-loading.tsx';
import { TryAgain } from '../../../../views/try-again.tsx';
import { Answer, Calm, Evidence, Eyebrow, Head, Ranked } from '../../../../views/calm.tsx';

interface Params {
  params: Promise<{ org: string; product: string; project: string }>;
}

async function projectFrom(params: Params['params']): Promise<PlaceholderProject> {
  const { org, product, project } = await params;
  const location = parseShellPath(`/${org}/${product}/${project}`);
  const found =
    location?.project === undefined ? undefined : findProject(product, location.project);
  if (found === undefined) notFound();
  return found;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  return { title: (await projectFrom(params)).name };
}

// Stands in for the data that never arrives, so the loading state can be seen and tested.
const never = () => new Promise<never>(() => undefined);

// The project is known before anything streams, so an unknown one is a real 404; only its
// data waits behind the skeleton.
export default async function ProjectHome({ params }: Params) {
  const project = await projectFrom(params);
  const { org } = await params;
  return (
    <>
      <MainBusy busy />
      <Suspense fallback={<ProjectLoading name={project.name} />}>
        <MainBusy busy={false} />
        <ProjectBody org={org} project={project} />
      </Suspense>
    </>
  );
}

async function ProjectBody({ org, project }: { org: string; project: PlaceholderProject }) {
  const href = (section?: string) =>
    shellHref({
      org,
      product: project.product,
      project: project.slug,
      ...(section === undefined ? {} : { section }),
    });

  // The page renders alongside the layout, so it checks the flag itself before it waits;
  // with the flag off the response ends as a 404 instead of hanging.
  if (project.slug === 'pending') {
    await requireDashboard(PLACEHOLDER.organization.id);
    await never();
  }

  if (project.slug === 'unreachable') {
    return (
      <Calm>
        <Head>
          <Eyebrow>{project.name}</Eyebrow>
          <Badge state="broken">Could not load</Badge>
          <Answer
            claim="We could not load this project."
            rest="Your docs site is still online; only the dashboard is affected."
          />
          <Evidence>
            If it keeps happening, send us this reference:{' '}
            <code className="font-mono text-code text-ink">req_8f2a91</code>
          </Evidence>
        </Head>
        <div className="flex flex-wrap items-center gap-8">
          <TryAgain />
          <ButtonLink variant="quiet" href="https://status.drefyn.com">
            Check status.drefyn.com
          </ButtonLink>
        </div>
      </Calm>
    );
  }

  if (project.slug === 'new-docs') {
    return (
      <Calm>
        <Head>
          <Eyebrow>{project.name}</Eyebrow>
          <Answer
            claim="No pages yet."
            rest="Generate them from your repository, or write the first one."
          />
          <Evidence>
            Generation reads your OpenAPI spec and README and takes about five minutes. It uses
            about 40 of your 500 AI credits.
          </Evidence>
        </Head>
        <div className="flex flex-wrap gap-8">
          <ButtonLink variant="primary" href={href('settings')}>
            Generate from repository
          </ButtonLink>
          <ButtonLink variant="secondary" href={href('pages')}>
            Write a page
          </ButtonLink>
        </div>
      </Calm>
    );
  }

  if (project.product === 'status') {
    return (
      <Calm>
        <Head>
          <Eyebrow>{project.name}</Eyebrow>
          <Answer
            claim="Everything is running."
            rest="14 components, checked from 6 regions 40 seconds ago."
          />
          <Evidence>
            <span>
              Last check at <time dateTime="2026-10-27T14:19:20Z">14:19 UTC</time>
            </span>
          </Evidence>
        </Head>
        <Ranked
          label="Needs you"
          items={[
            {
              id: 'checkout',
              mark: <StatusPip state="neutral" label="Not monitored" />,
              title: 'Add a monitor to Checkout',
              href: href('monitors'),
              detail: 'Checkout shows as running only because nothing checks it yet.',
              when: <time dateTime="2026-10-24T10:00:00Z">3 days ago</time>,
            },
          ]}
        />
      </Calm>
    );
  }

  return (
    <Calm>
      <Head>
        <Eyebrow>{project.name}</Eyebrow>
        <Answer claim="3 pages are out of date." rest="The other 47 match your API." />
        <Evidence>
          <span>
            Checked against <code className="font-mono text-code text-ink">openapi.yaml</code> at
            commit <code className="font-mono text-code text-ink">8f2c1a0</code>
          </span>
          <span>
            <time dateTime="2026-10-27T14:20:00Z">14:20 UTC</time>, 6 minutes ago
          </span>
        </Evidence>
      </Head>
      <Ranked
        label="Needs you"
        items={[
          {
            id: 'refunds',
            mark: <StatusPip state="stale" label="Out of date" />,
            title: 'Refunds',
            href: href('pages'),
            detail: (
              <>
                <code className="font-mono text-code text-ink">refund.reason</code> changed from
                text to a fixed list on 24 Oct.
              </>
            ),
            when: <time dateTime="2026-10-24T09:12:00Z">24 Oct</time>,
          },
          {
            id: 'payout',
            mark: <StatusPip state="stale" label="Out of date" />,
            title: 'Create a payout',
            href: href('pages'),
            detail: (
              <>
                <code className="font-mono text-code text-ink">payout.currency</code> is now
                required.
              </>
            ),
            when: <time dateTime="2026-10-24T09:12:00Z">24 Oct</time>,
          },
          {
            id: 'webhooks',
            mark: <StatusPip state="stale" label="Out of date" />,
            title: 'Webhooks overview',
            href: href('pages'),
            detail: (
              <>
                The <code className="font-mono text-code text-ink">charge.disputed</code> event was
                removed.
              </>
            ),
            when: <time dateTime="2026-10-23T16:40:00Z">23 Oct</time>,
          },
        ]}
      />
      <dl className="grid grid-cols-1 gap-24 sm:grid-cols-3">
        {[
          ['Pages', '50', 'of 300 on Starter'],
          ['Readers, 7 days', '4,212', 'Up 8 percent on last week'],
          ['Search answered', '92%', 'of 1,804 searches'],
        ].map(([label, figure, note]) => (
          <div key={label} className="flex flex-col gap-4 border-t border-rule pt-12">
            <dt className="text-label text-secondary uppercase">{label}</dt>
            <dd className="text-title text-ink" data-numeric="">
              {figure}
            </dd>
            <dd className="text-caption text-secondary">{note}</dd>
          </div>
        ))}
      </dl>
    </Calm>
  );
}
