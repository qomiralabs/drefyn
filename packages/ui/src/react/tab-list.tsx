'use client';
import type { ReactNode } from 'react';
import { TabList as AriaTabList } from 'react-aria-components';

export interface TabListProps {
  // Names the row of tabs for screen readers.
  label: string;
  // Tab elements.
  children: ReactNode;
}

// The row sits on a hairline rule. The rule is drawn first, so the selected tab's indicator,
// drawn on the same baseline, paints over it.
export function TabList({ label, children }: TabListProps): ReactNode {
  if (label.trim() === '') throw new Error('A TabList needs a label to name it.');
  return (
    <div className="relative">
      <span aria-hidden="true" className="absolute inset-x-0 bottom-0 border-b border-rule" />
      <AriaTabList aria-label={label} className="flex gap-4 overflow-x-auto">
        {children}
      </AriaTabList>
    </div>
  );
}
