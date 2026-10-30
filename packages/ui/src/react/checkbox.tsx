'use client';
import type { ReactNode } from 'react';

export interface CheckboxProps {
  // The visible label.
  children: ReactNode;
  checked?: boolean;
  defaultChecked?: boolean;
  // Some of what the box stands for is checked, such as a select all box over a table.
  indeterminate?: boolean;
  onChange?: (checked: boolean) => void;
  // Rendered as aria-disabled so the box stays focusable and its reason can be read.
  disabled?: boolean;
  description?: ReactNode;
  // The message for an invalid value. Setting it marks the box invalid.
  error?: string;
  required?: boolean;
  name?: string;
  value?: string;
}

// TODO(#58): React Aria CheckboxField on a real checkbox input.
export const Checkbox: (props: CheckboxProps) => ReactNode = () => null;
