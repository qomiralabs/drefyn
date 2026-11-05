'use client';
import { Button, ButtonLink, Skeleton } from '@drefyn/ui/react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { Answer, Calm, Head } from '../views/calm.tsx';
import { MainBusy } from '../views/main-busy.tsx';
import type { CockpitProps } from './cockpit.tsx';
import { START_ITEM } from './feed.ts';
import { loadCockpit } from './load-cockpit.ts';
import { useIncident } from './provider.tsx';

// The cockpit's panes in skeleton blocks, so nothing jumps when the chunk lands.
function CockpitLoading(): ReactNode {
  return (
    <div className="flex max-w-page flex-col gap-24 px-16 pt-24 pb-96 sm:px-24">
      <MainBusy busy />
      <h1 className="sr-only">Incident</h1>
      <div className="flex flex-col gap-12">
        <Skeleton width="1/4" />
        <span className="block h-32">
          <Skeleton shape="block" width="3/4" />
        </span>
      </div>
      <div className="grid incident-panes items-start gap-24">
        {[0, 1, 2].map((pane) => (
          <div key={pane} className="flex flex-col gap-12">
            <Skeleton width="1/4" />
            <span className="block h-128">
              <Skeleton shape="block" />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Loaded(): ReactNode {
  const { entering, heading, resolve, incident } = useIncident();
  const [Cockpit, setCockpit] = useState<ComponentType<CockpitProps> | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    loadCockpit()
      .then((component) => {
        if (current) setCockpit(() => component);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [attempt]);

  if (failed) {
    return (
      <Calm>
        <Head>
          <Answer
            claim="We could not open this incident."
            rest="It is still open, and your status page is not affected."
          />
        </Head>
        <div>
          <Button
            variant="primary"
            onClick={() => {
              setFailed(false);
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </Button>
        </div>
      </Calm>
    );
  }
  if (Cockpit === null || incident == null) return <CockpitLoading />;
  return <Cockpit incident={incident} entering={entering} heading={heading} onResolve={resolve} />;
}

// The page behind an incident URL. The feed lives in the browser, so the server sends the
// skeleton and this decides what it becomes.
export function IncidentRoute({ item }: { item: string }): ReactNode {
  const { incident, start, cockpitHref, calmHref } = useIncident();
  const router = useRouter();
  const starting = item === START_ITEM;
  const open = incident?.id === item;
  const [hadIt, setHadIt] = useState(false);
  if (open && !hadIt) setHadIt(true);

  useEffect(() => {
    if (!starting || incident === undefined) return;
    if (incident === null) start();
    else if (cockpitHref !== null) router.replace(cockpitHref);
  }, [starting, incident, cockpitHref, start, router]);

  if (open) return <Loaded />;
  // Resolved here: the shell is already on its way back, so this view never shows.
  if (starting || incident === undefined || hadIt) return <CockpitLoading />;
  return (
    <Calm>
      <Head>
        <Answer claim="This incident is not open." rest="It may already be resolved." />
      </Head>
      <div>
        <ButtonLink variant="secondary" href={calmHref}>
          Back to Status
        </ButtonLink>
      </div>
    </Calm>
  );
}
