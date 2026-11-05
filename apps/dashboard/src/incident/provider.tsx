'use client';
import { toast } from '@drefyn/ui/react';
import { usePathname, useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  createFixtureFeed,
  type FeedStorage,
  type IncidentFeed,
  type OpenIncident,
} from './feed.ts';
import { isIncidentPath, shift, viewOf, type IncidentView, type Seen } from './shift.ts';

interface IncidentState {
  // Undefined until the browser has read the feed, so the server never guesses.
  readonly incident: OpenIncident | null | undefined;
  readonly view: IncidentView;
  // True when the person stepped in, not when the page was opened cold.
  readonly entering: boolean;
  // Where Back to calm view goes: the place the person came from.
  readonly calmHref: string;
  readonly cockpitHref: string | null;
  readonly heading: (element: HTMLElement | null) => void;
  readonly start: () => void;
  readonly resolve: () => void;
}

const IncidentContext = createContext<IncidentState | null>(null);

export function useIncident(): IncidentState {
  const state = useContext(IncidentContext);
  if (state === null) throw new Error('useIncident needs the incident provider.');
  return state;
}

const projectHome = (org: string, project: string) => `/${org}/status/${project}`;

const inMemory = (): FeedStorage => {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
};

// Reading localStorage throws where a browser blocks site data.
function browserStorage(): FeedStorage {
  try {
    return window.localStorage;
  } catch {
    return inMemory();
  }
}

const noFeed = () => () => undefined;
const notRead = () => undefined;

function restoreFocus(element: HTMLElement | null): void {
  if (element?.isConnected === true) {
    element.focus();
    if (document.activeElement === element) return;
  }
  // A person who left by the link on the line is still on it, and that is a fine place to be.
  if (document.activeElement !== document.body) return;
  const heading = document.querySelector<HTMLElement>('#main h1');
  if (heading === null) {
    document.getElementById('main')?.focus();
    return;
  }
  heading.tabIndex = -1;
  heading.focus();
}

// Owns the shell's incident state: reads the feed, turns its changes into focus moves and
// announcements, and marks the shell so the sidebar can step back. One live region each for
// polite and assertive stay mounted, because a screen reader only hears changes to a region
// that was already there.
export function IncidentProvider({
  org,
  permissions,
  children,
}: {
  org: string;
  permissions: readonly string[];
  children: ReactNode;
}): ReactNode {
  const router = useRouter();
  const pathname = usePathname();
  const [feed] = useState<IncidentFeed | null>(() =>
    typeof window === 'undefined' ? null : createFixtureFeed(org, browserStorage(), window),
  );
  const read = useSyncExternalStore(
    feed === null ? noFeed : feed.subscribe,
    feed === null ? notRead : feed.current,
    notRead,
  );
  // The incident line names a Status component, so it stays with people who can read Status.
  const mayRead = permissions.includes('status.read');
  const incident = read === undefined ? undefined : mayRead ? read : null;
  const view = viewOf(pathname, incident ?? null);

  // Derived while rendering, so the cockpit's first render already knows how it arrived.
  const [returnTo, setReturnTo] = useState<string | null>(null);
  if (!isIncidentPath(pathname) && pathname !== returnTo) setReturnTo(pathname);
  const [shown, setShown] = useState<{ read: boolean; view: IncidentView }>({
    read: incident !== undefined,
    view,
  });
  const [entering, setEntering] = useState(false);
  const [returned, setReturned] = useState(false);
  if (!shown.read) {
    if (incident !== undefined) setShown({ read: true, view });
  } else if (shown.view !== view) {
    setShown({ read: true, view });
    setEntering(view === 'cockpit');
    if (shown.view === 'cockpit') setReturned(true);
  }

  const [polite, setPolite] = useState({ text: '', turn: 0 });
  const [assertive, setAssertive] = useState({ text: '', turn: 0 });
  const seen = useRef<Seen | null>(null);
  const insideNow = useRef(false);
  const lastFocus = useRef<HTMLElement | null>(null);
  const headingEl = useRef<HTMLElement | null>(null);
  const pendingHeading = useRef<string | null>(null);
  const pendingRestore = useRef(false);
  const calmTo = useRef(returnTo);

  useEffect(() => {
    calmTo.current = returnTo;
    insideNow.current = view === 'cockpit';
  });

  const takeHeading = useCallback(() => {
    const text = pendingHeading.current;
    if (text === null || headingEl.current === null) return;
    pendingHeading.current = null;
    headingEl.current.focus();
    setAssertive((last) => ({ text, turn: last.turn + 1 }));
  }, []);

  // A callback ref, because the cockpit chunk can land before or after the shift is seen.
  const heading = useCallback(
    (element: HTMLElement | null) => {
      headingEl.current = element;
      takeHeading();
    },
    [takeHeading],
  );

  // Remembers where a person was before the shift. An open overlay does not count: closing
  // it hands focus back on its own, so what matters is what it was opened from.
  useEffect(() => {
    const onFocus = (event: FocusEvent) => {
      const { target } = event;
      if (!(target instanceof HTMLElement) || insideNow.current) return;
      if (target.closest('[role="dialog"]') === null) lastFocus.current = target;
    };
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('focusin', onFocus);
    };
  }, []);

  useEffect(() => {
    if (incident === undefined) return;
    const now: Seen = { incident, view };
    const before = seen.current;
    seen.current = now;
    if (before !== null) {
      for (const effect of shift(before, now)) {
        if (effect.kind === 'announce') {
          setPolite((last) => ({ text: effect.text, turn: last.turn + 1 }));
        } else if (effect.kind === 'focus-heading') {
          pendingHeading.current = effect.announce;
        } else if (effect.kind === 'resolved') {
          toast({ title: effect.text });
        } else if (effect.kind === 'restore-focus') {
          pendingHeading.current = null;
          pendingRestore.current = true;
        } else if (before.incident !== null) {
          router.replace(calmTo.current ?? projectHome(org, before.incident.project));
        }
      }
    }
    takeHeading();
    // Waits for the calm page: the cockpit's own URL is still showing after a resolve.
    if (pendingRestore.current && !isIncidentPath(pathname)) {
      pendingRestore.current = false;
      const element = lastFocus.current;
      requestAnimationFrame(() => {
        restoreFocus(element);
      });
    }
  }, [incident, view, pathname, org, router, takeHeading]);

  const state = useMemo<IncidentState>(
    () => ({
      incident,
      view,
      entering,
      calmHref:
        returnTo ?? (incident == null ? `/${org}/status` : projectHome(org, incident.project)),
      cockpitHref:
        incident == null ? null : `${projectHome(org, incident.project)}/incidents/${incident.id}`,
      heading,
      start: () => {
        feed?.start();
      },
      resolve: () => {
        feed?.resolve();
      },
    }),
    [incident, view, entering, returnTo, org, heading, feed],
  );

  return (
    <IncidentContext value={state}>
      {/* The shell's mode, so plain CSS can step the sidebar back without any script in it. */}
      <div
        className="contents"
        data-incident={view === 'cockpit' ? 'cockpit' : returned ? 'calm' : undefined}
      >
        {children}
      </div>
      <div data-announcer="polite" role="status" aria-atomic="true" className="sr-only">
        <span key={polite.turn}>{polite.text}</span>
      </div>
      <div data-announcer="assertive" role="alert" aria-atomic="true" className="sr-only">
        <span key={assertive.turn}>{assertive.text}</span>
      </div>
    </IncidentContext>
  );
}
