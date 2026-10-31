'use client';
import type { ReactNode } from 'react';
import { TabPanel as AriaTabPanel } from 'react-aria-components';

export interface TabPanelProps {
  // The value of the tab that shows this panel.
  value: string;
  children: ReactNode;
}

// A newly shown panel fades in on the duration token; it never moves, so reduced motion only
// shortens the fade. The panel it replaces leaves at once rather than fading out under it.
export function TabPanel({ value, children }: TabPanelProps): ReactNode {
  return (
    <AriaTabPanel
      id={value}
      className="rounded-sm outline-none transition-opacity duration-base ease-enter data-entering:opacity-0 data-exiting:hidden data-focus-visible:focus-ring"
    >
      {children}
    </AriaTabPanel>
  );
}
