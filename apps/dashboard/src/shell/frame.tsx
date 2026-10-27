'use client';
import { LazyMotion, MotionConfig } from 'motion/react';
import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import type { CommandBarProps } from './command-bar.tsx';
import { isTyping, nextRegion, sequenceTarget } from './keys.ts';
import { ShellToasts, toast } from './toast.tsx';

// Motion's animation features load after first paint; only movement the shell owns uses them.
const motionFeatures = () => import('motion/react').then((mod) => mod.domAnimation);

interface ShellState {
  readonly org: string;
  readonly drawerOpen: boolean;
  readonly setDrawerOpen: (open: boolean) => void;
  readonly toggleCommandBar: () => void;
}

const ShellContext = createContext<ShellState | null>(null);

export function useShell(): ShellState {
  const state = useContext(ShellContext);
  if (state === null) throw new Error('useShell needs the shell frame.');
  return state;
}

// The command bar is not in the first load: it arrives on the first Cmd+K or Ctrl+K.
const loadCommandBar = () => import('./command-bar.tsx').then((mod) => mod.CommandBar);

// Regions F6 moves between, in order. Hidden ones are skipped, so the cycle follows what a
// person can see at each width.
const REGIONS = ['[data-region="bar"]', '[data-region="nav"]', '#main'];

export function ShellFrame({ org, children }: { org: string; children: ReactNode }): ReactNode {
  const router = useRouter();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [CommandBar, setCommandBar] = useState<ComponentType<CommandBarProps> | null>(null);
  const loading = useRef(false);
  const pendingKey = useRef<{ key: string; at: number } | null>(null);

  // Read through a ref, so a key press that lands before React re-runs its effects still
  // sees the loaded command bar instead of loading it again.
  const loaded = useRef<ComponentType<CommandBarProps> | null>(null);
  const toggleCommandBar = useCallback(() => {
    if (loaded.current !== null) {
      setCommandOpen((open) => !open);
      return;
    }
    if (loading.current) return;
    loading.current = true;
    loadCommandBar()
      .then((component) => {
        loaded.current = component;
        setCommandBar(() => component);
        setCommandOpen(true);
      })
      .catch(() => {
        toast('Could not open search. Try again.');
      })
      .finally(() => {
        loading.current = false;
      });
  }, []);

  useEffect(() => {
    document.documentElement.dataset['shell'] = 'ready';
    return () => {
      delete document.documentElement.dataset['shell'];
    };
  }, []);

  // The handler reads changing state through refs and is attached once. Re-attaching it on
  // each state change would let Firefox run the new copy for the same key press, because the
  // update commits between listeners.
  const latest = useRef({ commandOpen, drawerOpen, org, router, toggleCommandBar });
  useEffect(() => {
    latest.current = { commandOpen, drawerOpen, org, router, toggleCommandBar };
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      // React Aria's autocomplete re-dispatches the field's keys to its list; only the
      // person's own key press counts, or Cmd+K would toggle twice.
      if (!event.isTrusted) return;
      const { commandOpen, drawerOpen, org, router, toggleCommandBar } = latest.current;
      const key = event.key.toLowerCase();
      // Cmd+K and Ctrl+K work everywhere, inside fields too.
      if (key === 'k' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        toggleCommandBar();
        return;
      }
      if (event.key === 'F6' && !event.altKey && !event.metaKey && !event.ctrlKey) {
        const regions = REGIONS.flatMap((selector) => {
          const el = document.querySelector<HTMLElement>(selector);
          return el !== null && el.offsetParent !== null ? [el] : [];
        });
        const index = nextRegion(
          regions.findIndex((el) => el.contains(document.activeElement)),
          regions.length,
          event.shiftKey,
        );
        const target = regions[index];
        if (target !== undefined) {
          event.preventDefault();
          target.focus();
        }
        return;
      }
      // Single key shortcuts never fire in a field, with a modifier, or over an overlay.
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      if (isTyping(document.activeElement) || commandOpen || drawerOpen) return;
      if (document.querySelector('[role="menu"], [role="dialog"]') !== null) return;
      const now = event.timeStamp;
      const target = sequenceTarget(pendingKey.current, key, now);
      pendingKey.current = target === null && key === 'g' ? { key, at: now } : null;
      if (target === null) return;
      event.preventDefault();
      router.push(target === 'overview' ? `/${org}` : `/${org}/${target}`);
    }
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
    };
  }, []);

  const state = useMemo(
    () => ({ org, drawerOpen, setDrawerOpen, toggleCommandBar }),
    [org, drawerOpen, toggleCommandBar],
  );

  return (
    <ShellContext value={state}>
      <MotionConfig reducedMotion="user">
        <LazyMotion features={motionFeatures} strict>
          {children}
          {CommandBar === null ? null : (
            <CommandBar org={org} open={commandOpen} onOpenChange={setCommandOpen} />
          )}
          <ShellToasts />
        </LazyMotion>
      </MotionConfig>
    </ShellContext>
  );
}
