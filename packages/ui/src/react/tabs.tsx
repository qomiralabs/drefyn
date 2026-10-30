'use client';
import type { ReactNode } from 'react';

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

// TODO(#58): React Aria Tabs with reachable disabled tabs.
export const Tabs: (props: TabsProps) => ReactNode = () => null;
