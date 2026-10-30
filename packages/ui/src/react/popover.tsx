'use client';
import type { ReactNode } from 'react';
import type { ButtonSize } from './button-classes.ts';

interface PopoverBase {
  // What the trigger shows.
  trigger: ReactNode;
  // The trigger's accessible name when it shows only an icon.
  triggerLabel?: string;
  variant?: 'secondary' | 'quiet';
  size?: ButtonSize;
  // A heading that names the panel. Without it the trigger names the panel.
  title?: string;
  // The panel's content.
  children: ReactNode;
  placement?: 'bottom start' | 'bottom end' | 'top start' | 'top end';
}

// The popover keeps its own open state, or the caller holds it. A caller that holds open must
// hear when it closes, or Escape and a click outside would do nothing.
interface OwnState {
  open?: never;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}
interface HeldState {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultOpen?: never;
}

export type PopoverProps = PopoverBase & (OwnState | HeldState);

// TODO(#58): React Aria DialogTrigger and a non modal Popover.
export const Popover: (props: PopoverProps) => ReactNode = () => null;
