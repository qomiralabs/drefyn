'use client';
import { tokens } from '@drefyn/ui';
import { Badge, Button, StatusDot, toast } from '@drefyn/ui/react';
import { m } from 'motion/react';
import { useState, type ReactNode, type RefCallback } from 'react';
import { ShellMotion } from '../shell/motion.tsx';
import { FIXTURE_DETAIL, type IncidentDetail } from './detail.ts';
import type { OpenIncident } from './feed.ts';
import { utcClock } from './shift.ts';

export interface CockpitProps {
  incident: OpenIncident;
  entering: boolean;
  heading: RefCallback<HTMLElement>;
  onResolve: () => void;
}

const { motion } = tokens;
const { shell } = tokens.layout;
const seconds = (ms: number) => ms / 1000;
const FORMAT = new Intl.NumberFormat('en-US');

// The panes glide in from where the sidebar's edge was, and the sidebar itself changes once.
// Only a transform moves, so the cockpit is laid out once however slow the machine. Read here
// as well as through MotionConfig, because Motion would still paint the first frame at the
// offset, and reduced motion means nothing is ever out of place.
function travel(): number {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 0;
  return window.matchMedia('(width >= 64rem)').matches
    ? shell.nav - shell.navCollapsed
    : motion.distance.enter;
}

const SPRING = { type: 'spring', ...motion.spring.default } as const;

const notYet = (what: string) => () => {
  toast({ title: `${what} is not available yet.` });
};

function PaneHeading({ id, children }: { id: string; children: string }): ReactNode {
  return (
    <h2 id={id} className="border-b border-rule pb-8 text-label text-secondary uppercase">
      {children}
    </h2>
  );
}

function Affected({ detail }: { detail: IncidentDetail }): ReactNode {
  return (
    <div className="flex flex-col gap-24">
      <section aria-labelledby="incident-affected" className="flex flex-col gap-8">
        <PaneHeading id="incident-affected">Affected</PaneHeading>
        <ul>
          {detail.affected.map((component) => (
            <li
              key={component.name}
              className="flex flex-col gap-2 border-b border-rule py-8 last:border-b-0"
            >
              <span className="font-medium text-ink">{component.name}</span>
              <Badge state={component.state}>{component.word}</Badge>
              <span className="text-caption text-secondary" data-numeric="">
                {component.note}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="incident-timeline" className="flex flex-col gap-8">
        <PaneHeading id="incident-timeline">Timeline</PaneHeading>
        <ol>
          {detail.timeline.map((entry) => (
            <li key={entry.at} className="flex gap-12 border-b border-rule py-8 last:border-b-0">
              <time dateTime={entry.at} data-numeric="" className="shrink-0 text-secondary">
                {utcClock(entry.at).slice(0, 5)}
              </time>
              <span className="min-w-0 text-body">{entry.text}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function Draft({ detail }: { detail: IncidentDetail }): ReactNode {
  const [text, setText] = useState(detail.draft.text);
  return (
    <section aria-labelledby="incident-draft" className="flex flex-col gap-12 max-sm:order-first">
      <PaneHeading id="incident-draft">Update waiting for you</PaneHeading>
      <div className="flex flex-col gap-12 rounded-md border border-rule-strong p-16">
        <p id="incident-draft-note" className="text-caption text-secondary">
          Drafted at{' '}
          <time dateTime={detail.draft.draftedAt}>{utcClock(detail.draft.draftedAt)}</time> from
          probe data. Nothing is published until you approve it.
        </p>
        <label htmlFor="incident-draft-text" className="sr-only">
          Draft update
        </label>
        <textarea
          id="incident-draft-text"
          value={text}
          aria-describedby="incident-draft-note incident-draft-reach"
          onChange={(event) => {
            setText(event.target.value);
          }}
          rows={7}
          className="w-full resize-y rounded-sm border border-control bg-ground p-8 text-body-s text-ink focus-visible:focus-ring"
        />
        <p id="incident-draft-reach" className="text-caption text-secondary">
          {detail.draft.reach}
        </p>
        <div className="flex flex-wrap gap-8">
          <Button variant="primary" onClick={notYet('Publishing')}>
            Publish update
          </Button>
          <Button variant="secondary" onClick={notYet('Saving a draft')}>
            Save draft
          </Button>
        </div>
      </div>
    </section>
  );
}

function Reach({ detail }: { detail: IncidentDetail }): ReactNode {
  return (
    <section
      aria-labelledby="incident-reach"
      className="flex flex-col gap-12 sm:max-lg:col-span-full"
    >
      <PaneHeading id="incident-reach">Reach</PaneHeading>
      <div className="flex flex-col gap-4">
        <p className="text-display-s text-ink" data-numeric="">
          {FORMAT.format(detail.reach.subscribers)}
        </p>
        <p className="text-caption text-secondary">subscribers hear about the next update</p>
      </div>
      <p className="text-body" data-numeric="">
        {detail.reach.channels}
      </p>
      <StatusDot state="live">{detail.reach.readers}</StatusDot>
      <h3 className="border-b border-rule pb-8 text-label text-secondary uppercase">
        Probe regions
      </h3>
      <table className="w-full border-collapse">
        <caption className="sr-only">Errors and p75 latency by probe region</caption>
        <thead>
          <tr className="border-b border-rule text-label text-secondary uppercase">
            <th scope="col" className="py-4 text-start font-regular">
              Region
            </th>
            <th scope="col" className="py-4 text-start font-regular">
              Errors
            </th>
            <th scope="col" className="py-4 text-end font-regular">
              p75
            </th>
          </tr>
        </thead>
        <tbody>
          {detail.regions.map((region) => (
            <tr key={region.name} className="border-b border-rule last:border-b-0">
              <th scope="row" className="py-4 text-start font-regular text-ink">
                {region.name}
              </th>
              <td className="py-4">
                <Badge state={region.failing ? 'broken' : 'fresh'}>
                  {region.failing ? 'Yes' : 'No'}
                </Badge>
              </td>
              <td className="py-4 text-end text-ink" data-numeric="">
                {FORMAT.format(region.p75Ms)} ms
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="grid min-h-96 place-content-center rounded-md border border-rule p-16 text-center text-caption text-secondary">
        The region map fills this space when it is built.
      </p>
    </section>
  );
}

export function Cockpit({ incident, entering, heading, onResolve }: CockpitProps): ReactNode {
  const detail = FIXTURE_DETAIL;
  return (
    <ShellMotion>
      {/* Clips the glide, which would otherwise widen the page while it runs. */}
      <div className="overflow-x-clip">
        <m.div
          data-cockpit=""
          initial={entering ? { opacity: 0, x: travel() } : false}
          animate={{ opacity: 1, x: 0 }}
          transition={{ ...SPRING, opacity: { duration: seconds(motion.duration.fast.ms) } }}
          className="flex max-w-page flex-col gap-24 px-16 pt-24 pb-96 sm:px-24"
        >
          {/* The button follows the heading, so Tab from the heading lands on it. */}
          <div className="flex items-start gap-x-24 gap-y-12 max-sm:flex-col">
            <div className="flex min-w-0 flex-1 flex-col gap-8">
              <p className="text-label text-secondary uppercase">
                Incident, started{' '}
                <time dateTime={incident.startedAt}>{utcClock(incident.startedAt)}</time>
              </p>
              <h1
                ref={heading}
                tabIndex={-1}
                className="text-display-s text-balance text-ink outline-none focus-visible:focus-ring"
              >
                {incident.spoken}. <span className="text-secondary">{detail.agreement}</span>
              </h1>
            </div>
            <Button variant="secondary" onClick={onResolve}>
              Resolve incident
            </Button>
          </div>
          <div className="grid incident-panes items-start gap-24">
            <Affected detail={detail} />
            <Draft detail={detail} />
            <Reach detail={detail} />
          </div>
        </m.div>
      </div>
    </ShellMotion>
  );
}
