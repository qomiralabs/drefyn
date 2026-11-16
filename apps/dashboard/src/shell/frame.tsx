'use client';
import { toast, ToastRegion } from '@drefyn/ui/react';
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
import { CommandFrame, type CommandBodyProps } from './command-frame.tsx';
import type { Command } from './commands.ts';
import type { ShellData } from './data.ts';
import { isTyping, sequenceTarget } from './keys.ts';
import type { ShortcutsSheetProps } from './shortcuts-sheet.tsx';
import { SINGLE_KEYS_STORAGE, singleKeysOn } from './shortcuts.ts';

interface ShellState {
  readonly org: string;
  readonly drawerOpen: boolean;
  readonly setDrawerOpen: (open: boolean) => void;
  readonly toggleCommandBar: () => void;
  readonly openShortcuts: () => void;
}

const ShellContext = createContext<ShellState | null>(null);

export function useShell(): ShellState {
  const state = useContext(ShellContext);
  if (state === null) throw new Error('useShell needs the shell frame.');
  return state;
}

// The command bar is not in the first load: it arrives on the first Cmd+K or Ctrl+K.
const loadCommandBar = () => import('./command-bar.tsx').then((mod) => mod.CommandBar);
// Nor is the shortcuts sheet, which most visits never open.
const loadShortcutsSheet = () => import('./shortcuts-sheet.tsx').then((mod) => mod.ShortcutsSheet);

// The control a person used to open something: a menu item counts as the button that opened
// its menu, which is where focus goes when the menu closes.
function openedFrom(active: Element | null): HTMLElement | null {
  const menu = active?.closest('[role="menu"]');
  const trigger =
    menu?.id === undefined || menu.id === ''
      ? null
      : document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(menu.id)}"]`);
  if (trigger !== null) return trigger;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

export function ShellFrame({
  org,
  orgName,
  permissions,
  projects,
  actions,
  children,
}: {
  org: string;
  orgName: string;
  permissions: readonly string[];
  projects: ShellData['projects'];
  actions: readonly Command[];
  children: ReactNode;
}): ReactNode {
  const router = useRouter();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [CommandBar, setCommandBar] = useState<ComponentType<CommandBarProps> | null>(null);
  const loading = useRef(false);
  const pendingKey = useRef<{ key: string; at: number } | null>(null);
  // Read in the load's callbacks, which outlive the render that started them.
  const isOpen = useRef(false);

  const showCommandBar = useCallback((open: boolean) => {
    isOpen.current = open;
    setCommandOpen(open);
    if (!open) setQuery('');
  }, []);

  // Read through a ref, so a key press that lands before React re-runs its effects still
  // sees the loaded command bar instead of loading it again.
  const loaded = useRef<ComponentType<CommandBarProps> | null>(null);
  // The frame opens on the press itself; only its results wait for their code. A failed load
  // closes the frame and says so, and the next press tries again.
  const toggleCommandBar = useCallback(() => {
    if (isOpen.current) {
      showCommandBar(false);
      return;
    }
    showCommandBar(true);
    if (loaded.current !== null || loading.current) return;
    loading.current = true;
    loadCommandBar()
      .then((component) => {
        loaded.current = component;
        setCommandBar(() => component);
      })
      .catch(() => {
        if (!isOpen.current) return;
        showCommandBar(false);
        toast({ title: 'Could not open search. Try again.', tone: 'error' });
      })
      .finally(() => {
        loading.current = false;
      });
  }, [showCommandBar]);

  const [Sheet, setSheet] = useState<ComponentType<ShortcutsSheetProps> | null>(null);
  const sheetLoaded = useRef(false);
  // React Aria hands focus back to whatever held it as the sheet mounted. When the sheet's code
  // lands before a closing menu has given focus back to its button, that is the page itself,
  // and Escape would leave focus nowhere. So the sheet remembers where it was opened from.
  const shortcutsFrom = useRef<HTMLElement | null>(null);
  const openShortcuts = useCallback(() => {
    shortcutsFrom.current = openedFrom(document.activeElement);
    if (sheetLoaded.current) {
      setShortcutsOpen(true);
      return;
    }
    loadShortcutsSheet()
      .then((component) => {
        sheetLoaded.current = true;
        setSheet(() => component);
        setShortcutsOpen(true);
      })
      .catch(() => {
        toast({ title: 'Could not open the shortcuts. Try again.', tone: 'error' });
      });
  }, []);

  // After React Aria's own return, which it makes in the frame after the close; this effect
  // runs later in the same commit, so its frame comes after that one.
  useEffect(() => {
    if (shortcutsOpen) return undefined;
    const from = shortcutsFrom.current;
    if (from === null) return undefined;
    shortcutsFrom.current = null;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if ((active === null || active === document.body) && from.isConnected) from.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [shortcutsOpen]);

  useEffect(() => {
    document.documentElement.dataset['shell'] = 'ready';
    return () => {
      delete document.documentElement.dataset['shell'];
    };
  }, []);

  // The handler reads changing state through refs and is attached once. Re-attaching it on
  // each state change would let Firefox run the new copy for the same key press, because the
  // update commits between listeners.
  const latest = useRef({ commandOpen, drawerOpen, org, router, toggleCommandBar, openShortcuts });
  useEffect(() => {
    latest.current = { commandOpen, drawerOpen, org, router, toggleCommandBar, openShortcuts };
  });

  // A person who turned single keys off in the sheet keeps that choice in this browser.
  const singleKeys = () => singleKeysOn(() => localStorage.getItem(SINGLE_KEYS_STORAGE));

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
      // Single key shortcuts never fire in a field, with a modifier, or over an overlay.
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      if (isTyping(document.activeElement) || commandOpen || drawerOpen) return;
      // The inbox stays open while people work, so only focus inside it holds the keys back.
      if (document.querySelector('[role="menu"], [role="dialog"]:not([data-inbox])') !== null) {
        return;
      }
      if (document.activeElement?.closest('[data-inbox]') != null) return;
      if (!singleKeys()) return;
      if (event.key === '?') {
        event.preventDefault();
        pendingKey.current = null;
        latest.current.openShortcuts();
        return;
      }
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
    () => ({ org, drawerOpen, setDrawerOpen, toggleCommandBar, openShortcuts }),
    [org, drawerOpen, toggleCommandBar, openShortcuts],
  );

  // The results, drawn by the loaded code with what the shell knows bound in. A render
  // function rather than a component, so a new render never remounts an open bar.
  const body =
    CommandBar === null
      ? null
      : (props: CommandBodyProps) => (
          <CommandBar
            {...props}
            org={org}
            orgName={orgName}
            permissions={permissions}
            projects={projects}
            actions={actions}
          />
        );

  return (
    <ShellContext value={state}>
      {children}
      <CommandFrame
        open={commandOpen}
        onOpenChange={showCommandBar}
        orgName={orgName}
        query={query}
        onQueryChange={setQuery}
        body={body}
      />
      {Sheet === null ? null : <Sheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />}
      <ToastRegion />
    </ShellContext>
  );
}
