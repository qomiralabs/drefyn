import { ButtonLink, StatusPip } from '@drefyn/ui/react';
import type { ReactNode } from 'react';
import { shellHref } from '../shell/route.ts';
import { Answer, Calm, Evidence, Eyebrow, Head, Ranked } from '../views/calm.tsx';
import { CouldNotLoad } from '../views/could-not-load.tsx';
import type { PlaceholderProject } from './projects.ts';

// What a project home looks like once a product feeds it, drawn from fixed words so the
// design holds until then. Only the state gallery draws these.
export function ProjectBody({
  org,
  project,
}: {
  org: string;
  project: PlaceholderProject;
}): ReactNode {
  const href = (section?: string) =>
    shellHref({
      org,
      product: project.product,
      project: project.slug,
      ...(section === undefined ? {} : { section }),
    });

  if (project.slug === 'unreachable') {
    return (
      <CouldNotLoad
        eyebrow={project.name}
        what="this project"
        rest="Your docs site is still online; only the dashboard is affected."
        reference="req_8f2a91"
      />
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
