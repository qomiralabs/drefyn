'use client';
import type { ReactNode } from 'react';

export interface TabPanelProps {
  // The value of the tab that shows this panel.
  value: string;
  children: ReactNode;
}

// TODO(#58): React Aria TabPanel that fades in.
export const TabPanel: (props: TabPanelProps) => ReactNode = () => null;
