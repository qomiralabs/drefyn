'use client';
import type { ReactNode } from 'react';

export interface RadioGroupProps {
  // The visible group label.
  label: string;
  // Radio elements.
  children: ReactNode;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  name?: string;
  description?: ReactNode;
  // The message for an invalid choice. Setting it marks the group invalid.
  error?: string;
  // Rendered as aria-disabled so every radio stays focusable and the reason can be read.
  disabled?: boolean;
  required?: boolean;
  orientation?: 'vertical' | 'horizontal';
}

// TODO(#58): React Aria RadioGroup with aria-disabled radios.
export const RadioGroup: (props: RadioGroupProps) => ReactNode = () => null;
