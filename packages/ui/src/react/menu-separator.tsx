'use client';
import type { ReactNode } from 'react';
import { Separator } from 'react-aria-components';

// A hairline between groups, running to the panel's edges.
export function MenuSeparator(): ReactNode {
  return <Separator className="-mx-4 my-4 border-t border-rule" />;
}
