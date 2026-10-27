'use client';
import type { ReactElement, ReactNode } from 'react';

export interface TooltipProps {
  // Short text that describes the trigger. Never the trigger's only name.
  content: string;
  // One focusable element that forwards its ref, such as a Button or ButtonLink.
  children: ReactElement;
  placement?: 'top' | 'bottom' | 'start' | 'end';
  defaultOpen?: boolean;
}

// TODO(#58): React Aria TooltipTrigger and Tooltip around a Focusable child.
export const Tooltip: (props: TooltipProps) => ReactNode = ({ children }) => children;
