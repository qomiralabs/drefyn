'use client';
import type { ReactNode } from 'react';

export interface TabListProps {
  // Names the row of tabs for screen readers.
  label: string;
  // Tab elements.
  children: ReactNode;
}

// TODO(#58): React Aria TabList on the rule.
export const TabList: (props: TabListProps) => ReactNode = () => null;
