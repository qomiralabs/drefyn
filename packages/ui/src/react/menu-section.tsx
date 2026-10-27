'use client';
import type { ReactNode } from 'react';

export interface MenuSectionProps {
  title: string;
  children: ReactNode;
}

// TODO(#58): React Aria MenuSection with a Header.
export const MenuSection: (props: MenuSectionProps) => ReactNode = () => null;
