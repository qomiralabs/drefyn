'use client';
import type { ReactNode } from 'react';

export interface MenuItemProps {
  id: string;
  children: ReactNode;
  onAction?: () => void;
  // Stays reachable by arrow keys and announces as unavailable.
  disabled?: boolean;
  shortcut?: string;
  icon?: ReactNode;
}

// TODO(#58): React Aria MenuItem.
export const MenuItem: (props: MenuItemProps) => ReactNode = () => null;
