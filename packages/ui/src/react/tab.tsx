'use client';
import type { ReactNode } from 'react';

export interface TabProps {
  value: string;
  children: string;
  // A count shown after the label in tabular figures, such as the pages behind the tab.
  count?: number;
  // Stays reachable by the arrow keys, announces as unavailable and is never shown.
  disabled?: boolean;
}

// TODO(#58): React Aria Tab with the indicator.
export const Tab: (props: TabProps) => ReactNode = () => null;
