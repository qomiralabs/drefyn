'use client';
import { Children, isValidElement, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Tabs as AriaTabs, type Key } from 'react-aria-components';
import { Tab } from './tab.tsx';
import { TabRegistryContext } from './tab-registry.ts';

export interface TabsProps {
  // One TabList, then a TabPanel per tab.
  children: ReactNode;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  // Automatic shows a panel as the arrows reach its tab. Manual waits for Enter or Space,
  // for panels that fetch.
  activation?: 'automatic' | 'manual';
}

type Known = [value: string, disabled: boolean][];

// The tabs the elements show directly, so the server renders the right panel with no effect.
// A Tab inside a caller's own component is not seen here; it reports itself once mounted.
function tabsIn(children: ReactNode): Known {
  const found: Known = [];
  for (const child of Children.toArray(children)) {
    if (!isValidElement<{ children?: ReactNode; value?: string; disabled?: boolean }>(child)) {
      continue;
    }
    if (child.type === Tab) {
      if (child.props.value !== undefined) {
        found.push([child.props.value, child.props.disabled === true]);
      }
      continue;
    }
    found.push(...tabsIn(child.props.children));
  }
  return found;
}

// The tab to show: the one asked for when it can be shown, otherwise the first that can, and
// none when every tab is disabled. Before any tab is known, the one asked for is kept.
function resolve(wanted: string | null, known: Known): string | null {
  if (known.length === 0) return wanted;
  const available = known.filter(([, disabled]) => !disabled).map(([value]) => value);
  if (wanted !== null && available.includes(wanted)) return wanted;
  return available[0] ?? null;
}

// Held when every tab is disabled. It names no tab, so nothing is selected and no panel
// shows. Null would not do: React Aria then picks a tab itself on every render, and refusing
// it makes it pick again without end.
const NONE: Key = '\u0000none';

// React Aria would take a disabled tab out of arrow key navigation, so it is never told.
// Instead the selection is held here, never names a disabled tab, and React Aria is always
// controlled, so its own state never picks one.
export function Tabs({
  children,
  value,
  defaultValue,
  onChange,
  activation = 'automatic',
}: TabsProps): ReactNode {
  const registry = useRef(new Map<string, boolean>());
  const [own, setOwn] = useState<string | null>(defaultValue ?? null);
  const [, refresh] = useState(0);
  const wanted = value ?? own;
  const known = (): Known => (registry.current.size > 0 ? [...registry.current] : tabsIn(children));
  const shown = resolve(wanted, known());

  // Runs after every Tab has reported itself and before paint, so a wrapped disabled Tab the
  // elements hid moves the selection on before its panel is ever seen.
  // New children can bring new tabs, so they count as a reason to look again.
  useLayoutEffect(() => {
    if (resolve(wanted, [...registry.current]) !== shown) refresh((n) => n + 1);
  }, [wanted, shown, children]);

  return (
    <AriaTabs
      selectedKey={shown ?? NONE}
      onSelectionChange={(key) => {
        const next = String(key);
        if (!known().some(([v, disabled]) => v === next && !disabled)) return;
        if (value === undefined) setOwn(next);
        onChange?.(next);
      }}
      keyboardActivation={activation}
      className="flex flex-col"
    >
      <TabRegistryContext value={registry}>{children}</TabRegistryContext>
    </AriaTabs>
  );
}
