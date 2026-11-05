// The seam between the shell and whatever knows about incidents. Status has no API yet, so the
// fixture feed below is the only source. A live feed implements IncidentFeed and nothing else
// in the shell changes: the shell only reads current() and listens for changes.
export interface OpenIncident {
  readonly id: string;
  // The Status project it belongs to, as a slug in the URL.
  readonly project: string;
  // The sentence on the incident line.
  readonly claim: string;
  // The heading, and what is said on entering.
  readonly spoken: string;
  // What is said when it opens while the person is elsewhere.
  readonly opened: string;
  readonly startedAt: string;
  readonly resolvedAt: string;
}

export interface IncidentFeed {
  readonly current: () => OpenIncident | null;
  readonly subscribe: (listener: () => void) => () => void;
  readonly start: () => void;
  readonly resolve: () => void;
}

export const START_ITEM = 'new';

export const FIXTURE_INCIDENT: OpenIncident = {
  id: 'inc-payments-europe',
  project: 'acme-status',
  claim: 'Payments API has a partial outage in Europe',
  spoken: 'Payments API is failing in Europe',
  opened: 'Payments API, partial outage in Europe',
  startedAt: '2026-10-27T14:02:00Z',
  resolvedAt: '2026-10-27T14:51:00Z',
};

// A route can only exist for what the server knows, and the fixture is all it knows.
export function incidentRouteExists(product: string, project: string, item: string): boolean {
  if (product !== 'status' || project !== FIXTURE_INCIDENT.project) return false;
  return item === FIXTURE_INCIDENT.id || item === START_ITEM;
}

export type FeedStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface FeedEvents {
  addEventListener(type: 'storage', listener: (event: { key: string | null }) => void): void;
  removeEventListener(type: 'storage', listener: (event: { key: string | null }) => void): void;
}

// Kept in local storage so a reload stays in the incident, and so a second tab plays the part
// of an incident that opens or resolves while the person is doing something else.
export function createFixtureFeed(
  org: string,
  storage: FeedStorage,
  events: FeedEvents,
): IncidentFeed {
  const key = `dr-incident-fixture:${org}`;
  const listeners = new Set<() => void>();
  const stored = (): boolean => {
    try {
      return storage.getItem(key) !== null;
    } catch {
      return false;
    }
  };
  let open = stored();

  const tell = () => {
    for (const listener of listeners) listener();
  };
  const set = (next: boolean) => {
    if (next === open) return;
    open = next;
    try {
      if (next) storage.setItem(key, FIXTURE_INCIDENT.id);
      else storage.removeItem(key);
    } catch {
      // Refused storage only costs the reload and the second tab; this tab still works.
    }
    tell();
  };
  const onStorage = (event: { key: string | null }) => {
    if (event.key !== key && event.key !== null) return;
    const next = stored();
    if (next === open) return;
    open = next;
    tell();
  };

  return {
    current: () => (open ? FIXTURE_INCIDENT : null),
    subscribe: (listener) => {
      if (listeners.size === 0) events.addEventListener('storage', onStorage);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) events.removeEventListener('storage', onStorage);
      };
    },
    start: () => {
      set(true);
    },
    resolve: () => {
      set(false);
    },
  };
}
