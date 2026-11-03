'use client';
import { createContext, useContext, useLayoutEffect, type RefObject } from 'react';

// Every tab of a Tabs, by value, in the order they mounted, with whether it is disabled. The
// elements alone cannot say this when a caller wraps a Tab in a component of its own, so
// each Tab reports itself. A Tab can change on its own render, with no render of the Tabs
// above it, so each report also tells the Tabs to look again.
export interface TabRegistry {
  tabs: RefObject<Map<string, boolean>>;
  changed: () => void;
}

export const TabRegistryContext = createContext<TabRegistry | null>(null);

export function useRegisterTab(value: string, disabled: boolean): void {
  const registry = useContext(TabRegistryContext);
  // Joining and leaving keep the mount order; a change of disabled updates the entry in place,
  // since setting a key a Map already holds keeps its position. A join is reported by the
  // second effect, which always follows it with the real disabled value.
  useLayoutEffect(() => {
    if (registry === null) return;
    // The map lives as long as the Tabs, so the one read here is the one to clean.
    const tabs = registry.tabs.current;
    tabs.set(value, true);
    return () => {
      tabs.delete(value);
      registry.changed();
    };
  }, [registry, value]);
  useLayoutEffect(() => {
    if (registry === null) return;
    registry.tabs.current.set(value, disabled);
    registry.changed();
  }, [registry, value, disabled]);
}
