'use client';
import { createContext, useContext, useLayoutEffect, type RefObject } from 'react';

// Every tab of a Tabs, by value, in the order they mounted, with whether it is disabled. The
// elements alone cannot say this when a caller wraps a Tab in a component of its own, so
// each Tab reports itself and the Tabs reads the list after they have all mounted.
export type TabRegistry = RefObject<Map<string, boolean>>;

export const TabRegistryContext = createContext<TabRegistry | null>(null);

export function useRegisterTab(value: string, disabled: boolean): void {
  const registry = useContext(TabRegistryContext);
  // Joining and leaving keep the mount order; a change of disabled updates the entry in place,
  // since setting a key a Map already holds keeps its position.
  useLayoutEffect(() => {
    if (registry === null) return;
    // The map lives as long as the Tabs, so the one read here is the one to clean.
    const tabs = registry.current;
    tabs.set(value, true);
    return () => {
      tabs.delete(value);
    };
  }, [registry, value]);
  useLayoutEffect(() => {
    registry?.current.set(value, disabled);
  }, [registry, value, disabled]);
}
