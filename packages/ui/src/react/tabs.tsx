'use client';
import { Children, isValidElement, useState, type ReactNode } from 'react';
import { Tabs as AriaTabs } from 'react-aria-components';
import { Tab } from './tab.tsx';
import { UnavailableContext, useUnavailableSet } from './unavailable.ts';

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

// The first tab that can be shown, read from the elements, so the server renders the same
// panel the browser does and nothing waits for an effect.
function firstAvailable(children: ReactNode): string | null {
  for (const child of Children.toArray(children)) {
    if (!isValidElement<{ children?: ReactNode; value?: string; disabled?: boolean }>(child)) {
      continue;
    }
    if (child.type === Tab) {
      if (child.props.disabled !== true && child.props.value !== undefined)
        return child.props.value;
      continue;
    }
    const inner = firstAvailable(child.props.children);
    if (inner !== null) return inner;
  }
  return null;
}

// React Aria tabs. React Aria would take a disabled tab out of arrow key navigation, so it is
// never told: each disabled Tab registers its value and the selection refuses it. The value
// is always held here for the same reason.
export function Tabs({
  children,
  value,
  defaultValue,
  onChange,
  activation = 'automatic',
}: TabsProps): ReactNode {
  const unavailable = useUnavailableSet();
  const [own, setOwn] = useState<string | null>(() => defaultValue ?? firstAvailable(children));
  const chosen = value ?? own;
  return (
    <AriaTabs
      // Null only when every tab is disabled; React Aria then picks one, which is refused.
      {...(chosen === null ? {} : { selectedKey: chosen })}
      onSelectionChange={(key) => {
        const next = String(key);
        if (unavailable.current.has(next)) return;
        if (value === undefined) setOwn(next);
        onChange?.(next);
      }}
      keyboardActivation={activation}
      className="flex flex-col"
    >
      <UnavailableContext value={unavailable}>{children}</UnavailableContext>
    </AriaTabs>
  );
}
