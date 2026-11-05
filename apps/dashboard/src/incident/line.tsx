'use client';
import { IconCross, useLandmark } from '@drefyn/ui/react';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, type ReactNode } from 'react';
import { parseShellPath } from '../shell/route.ts';
import { TextLink } from '../views/calm.tsx';
import type { OpenIncident } from './feed.ts';
import { loadCockpit } from './load-cockpit.ts';
import { useIncident } from './provider.tsx';
import { utcClock } from './shift.ts';

function Line({ incident }: { incident: OpenIncident }): ReactNode {
  const { view, calmHref, cockpitHref } = useIncident();
  const product = parseShellPath(usePathname())?.product;
  const ref = useRef<HTMLElement>(null);
  const landmark = useLandmark(ref, { role: 'region', label: 'Incident in progress' });
  const inside = view === 'cockpit';

  // People on a Status route are the ones about to open it, so the shift should not wait.
  useEffect(() => {
    if (product === 'status') void loadCockpit().catch(() => undefined);
  }, [product]);

  return (
    <section
      ref={ref}
      data-incident-line=""
      {...landmark}
      className="flex animate-settle flex-wrap items-center gap-x-12 gap-y-4 incident-gutter border-b border-rule bg-ground px-16 py-8 outline-none focus-visible:focus-ring-inset sm:px-24"
    >
      <span className="inline-flex shrink-0 text-state-broken-mark">
        <IconCross />
      </span>
      <p className="min-w-0 flex-1 text-body">
        <span className="font-medium text-ink">{incident.claim}</span> since{' '}
        <time dateTime={incident.startedAt} data-numeric="">
          {utcClock(incident.startedAt)}
        </time>
        . {inside ? 'You are in incident mode.' : 'A draft update is waiting for you.'}
      </p>
      <TextLink href={inside ? calmHref : (cockpitHref ?? calmHref)}>
        {inside ? 'Back to calm view' : 'Open incident'}
      </TextLink>
    </section>
  );
}

// One line on every shell route while an incident is open. Only the Status cockpit moves the
// layout; anywhere else a person keeps their place, and the line is how they get there.
export function IncidentLine(): ReactNode {
  const { incident } = useIncident();
  return incident == null ? null : <Line incident={incident} />;
}
