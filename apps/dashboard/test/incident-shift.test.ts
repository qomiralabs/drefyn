import { describe, expect, it } from 'vitest';
import { FIXTURE_INCIDENT as OPEN, START_ITEM } from '../src/incident/feed.ts';
import {
  isIncidentPath,
  shift,
  utcClock,
  viewOf,
  type Effect,
  type Seen,
} from '../src/incident/shift.ts';

const COCKPIT = `/acme/status/${OPEN.project}/incidents/${OPEN.id}`;
const STARTING = `/acme/status/${OPEN.project}/incidents/${START_ITEM}`;

const calm: Seen = { incident: null, view: 'elsewhere' };
const elsewhere: Seen = { incident: OPEN, view: 'elsewhere' };
const cockpit: Seen = { incident: OPEN, view: 'cockpit' };
const starting: Seen = { incident: null, view: 'starting' };
const startingOpen: Seen = { incident: OPEN, view: 'starting' };

const ENTER: Effect[] = [{ kind: 'focus-heading', announce: `Incident mode. ${OPEN.spoken}.` }];
const RESOLVED = `Incident resolved at 14:51 UTC. Back to the calm view.`;

describe('viewOf', () => {
  it.each([
    [COCKPIT, OPEN, 'cockpit'],
    [COCKPIT, null, 'elsewhere'],
    [STARTING, null, 'starting'],
    [STARTING, OPEN, 'starting'],
    ['/acme/status/acme-status', OPEN, 'elsewhere'],
    ['/acme/status/acme-status/incidents', OPEN, 'elsewhere'],
    ['/acme/docs/payments-api/pages', OPEN, 'elsewhere'],
    [`/acme/status/${OPEN.project}/incidents/inc-other`, OPEN, 'elsewhere'],
    ['/account', OPEN, 'elsewhere'],
  ] as const)('%s with %j is %s', (path, incident, view) => {
    expect(viewOf(path, incident)).toBe(view);
  });
});

describe('isIncidentPath', () => {
  it('knows the incident pages from everything else', () => {
    expect(isIncidentPath(COCKPIT)).toBe(true);
    expect(isIncidentPath(STARTING)).toBe(true);
    expect(isIncidentPath('/acme/status/acme-status/incidents')).toBe(false);
    expect(isIncidentPath('/account')).toBe(false);
  });
});

describe('utcClock', () => {
  it('reads a time in UTC whatever the local zone', () => {
    expect(utcClock('2026-10-27T14:02:00Z')).toBe('14:02 UTC');
  });
});

describe('shift', () => {
  it('stays silent while nothing changes', () => {
    for (const seen of [calm, elsewhere, cockpit, starting]) {
      expect(shift(seen, seen)).toEqual([]);
    }
  });

  it('says politely that an incident opened elsewhere, and moves nothing', () => {
    expect(shift(calm, elsewhere)).toEqual([
      { kind: 'announce', politeness: 'polite', text: `Incident opened: ${OPEN.opened}` },
    ]);
  });

  it('takes focus and announces firmly when a person enters', () => {
    expect(shift(elsewhere, cockpit)).toEqual(ENTER);
  });

  it('enters from the start page, and starting says nothing of its own', () => {
    expect(shift(starting, startingOpen)).toEqual([]);
    expect(shift(startingOpen, cockpit)).toEqual(ENTER);
  });

  it('enters when an open incident lands on the cockpit page', () => {
    expect(shift({ incident: null, view: 'elsewhere' }, cockpit)).toEqual(ENTER);
  });

  it('restores focus and says the incident is still open on going back to calm', () => {
    expect(shift(cockpit, elsewhere)).toEqual([
      { kind: 'restore-focus' },
      {
        kind: 'announce',
        politeness: 'polite',
        text: 'Back to the calm view. The incident is still open.',
      },
    ]);
  });

  it('leaves the cockpit, restores focus and confirms when resolved inside it', () => {
    expect(shift(cockpit, calm)).toEqual([
      { kind: 'resolved', text: RESOLVED },
      { kind: 'leave' },
      { kind: 'restore-focus' },
    ]);
  });

  it('confirms without moving anything when resolved from elsewhere', () => {
    expect(shift(elsewhere, calm)).toEqual([{ kind: 'resolved', text: RESOLVED }]);
  });
});
