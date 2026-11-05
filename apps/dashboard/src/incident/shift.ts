import { parseShellPath } from '../shell/route.ts';
import { START_ITEM, type OpenIncident } from './feed.ts';

// Where the person is relative to the incident. Only the cockpit moves the shell.
export type IncidentView = 'cockpit' | 'starting' | 'elsewhere';

export interface Seen {
  readonly incident: OpenIncident | null;
  readonly view: IncidentView;
}

export type Effect =
  | { readonly kind: 'announce'; readonly politeness: 'polite'; readonly text: string }
  | { readonly kind: 'focus-heading'; readonly announce: string }
  | { readonly kind: 'restore-focus' }
  | { readonly kind: 'resolved'; readonly text: string }
  | { readonly kind: 'leave' };

export function viewOf(pathname: string, incident: OpenIncident | null): IncidentView {
  const item = parseShellPath(pathname)?.item;
  if (item === START_ITEM) return 'starting';
  return item !== undefined && item === incident?.id ? 'cockpit' : 'elsewhere';
}

export const isIncidentPath = (pathname: string): boolean =>
  parseShellPath(pathname)?.item !== undefined;

// Times in the shell are UTC so everyone on a call reads the same clock.
export function utcClock(iso: string): string {
  return `${new Date(iso).toISOString().slice(11, 16)} UTC`;
}

// What the person should notice when the shell goes from one state to the next. Moving focus
// is only ever a result of their own step; an incident that arrives by itself is only said.
export function shift(before: Seen, now: Seen): readonly Effect[] {
  const wasInside = before.view === 'cockpit';
  const isInside = now.view === 'cockpit';
  if (before.incident !== null && now.incident === null) {
    const text = `Incident resolved at ${utcClock(before.incident.resolvedAt)}. Back to the calm view.`;
    return wasInside
      ? [{ kind: 'resolved', text }, { kind: 'leave' }, { kind: 'restore-focus' }]
      : [{ kind: 'resolved', text }];
  }
  if (!wasInside && isInside) {
    return [{ kind: 'focus-heading', announce: `Incident mode. ${now.incident?.spoken ?? ''}.` }];
  }
  if (wasInside && !isInside) {
    return [
      { kind: 'restore-focus' },
      {
        kind: 'announce',
        politeness: 'polite',
        text: 'Back to the calm view. The incident is still open.',
      },
    ];
  }
  if (before.incident === null && now.incident !== null && now.view === 'elsewhere') {
    return [
      { kind: 'announce', politeness: 'polite', text: `Incident opened: ${now.incident.opened}` },
    ];
  }
  return [];
}
