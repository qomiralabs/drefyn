'use client';
import type { ReactNode } from 'react';

export interface SelectProps {
  // The visible label.
  label: string;
  // SelectOption elements.
  children: ReactNode;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  // Shown while nothing is chosen.
  placeholder?: string;
  name?: string;
  description?: ReactNode;
  // The message for an invalid choice. Setting it marks the select invalid.
  error?: string;
  // Rendered as aria-disabled so the trigger stays focusable and the reason can be read.
  disabled?: boolean;
  required?: boolean;
  // The options are still on their way: the list shows skeleton rows.
  loading?: boolean;
  size?: 'md' | 'lg';
  defaultOpen?: boolean;
}

// TODO(#58): React Aria Select with a field trigger and overlay list.
export const Select: (props: SelectProps) => ReactNode = () => null;
