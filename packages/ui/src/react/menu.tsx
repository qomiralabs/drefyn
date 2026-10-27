'use client';
import type { ReactNode } from 'react';
import type { ButtonSize } from './button-classes.ts';

export interface MenuProps {
  // What the trigger shows.
  trigger: ReactNode;
  // The trigger's accessible name when it shows only an icon.
  triggerLabel?: string;
  variant?: 'secondary' | 'quiet';
  size?: ButtonSize;
  // The menu's accessible name; the trigger names it when this is not set.
  label?: string;
  onAction?: (id: string) => void;
  defaultOpen?: boolean;
  children: ReactNode;
}

// TODO(#58): React Aria MenuTrigger, Popover and Menu.
export const Menu: (props: MenuProps) => ReactNode = () => null;
