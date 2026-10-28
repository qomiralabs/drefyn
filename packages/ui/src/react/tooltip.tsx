'use client';
import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { Focusable, Tooltip as AriaTooltip, TooltipTrigger } from 'react-aria-components';
import { tokens } from '../tokens/tokens.ts';

export interface TooltipProps {
  // Short text that describes the trigger. Never the trigger's only name.
  content: string;
  // One focusable element that forwards its ref, such as a Button or ButtonLink.
  children: ReactElement;
  placement?: 'top' | 'bottom' | 'start' | 'end';
  defaultOpen?: boolean;
}

// Focusable is typed for a host element, but it only clones the child with its handlers and
// a ref, which Button and ButtonLink pass straight to their element.
type FocusableChild = ComponentProps<typeof Focusable>['children'];

// React Aria opens it on keyboard focus at once and on hover after the wait, never on touch,
// keeps it open while the pointer is on it, closes it on Escape without moving focus, and
// describes the trigger with it. Focusable lends those handlers to a plain element, so our
// native Button and ButtonLink work as triggers. A disabled Button keeps its hover and focus
// handlers for exactly this.
export function Tooltip({
  content,
  children,
  placement = 'top',
  defaultOpen = false,
}: TooltipProps): ReactNode {
  if (content.trim() === '') throw new Error('Tooltip needs text to show.');
  return (
    <TooltipTrigger delay={tokens.timer.tooltip.ms} defaultOpen={defaultOpen}>
      <Focusable>{children as FocusableChild}</Focusable>
      <AriaTooltip
        placement={placement}
        offset={tokens.space[4]}
        className="z-overlay max-w-measure rounded-sm border border-rule-strong bg-overlay px-8 py-4 text-caption text-body shadow-1"
      >
        {content}
      </AriaTooltip>
    </TooltipTrigger>
  );
}
