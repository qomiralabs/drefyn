'use client';
import type { ReactNode } from 'react';

export interface SelectOptionProps {
  value: string;
  // Text only, so typing a letter can find the option.
  children: string;
  description?: string;
  // Stays reachable by the arrow keys, announces as unavailable and is never chosen.
  disabled?: boolean;
}

// TODO(#58): React Aria ListBoxItem with a tick.
export const SelectOption: (props: SelectOptionProps) => ReactNode = () => null;
