'use client';
import type { ReactNode } from 'react';

export interface SwitchProps {
  // The visible label.
  children: ReactNode;
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  // Rendered as aria-disabled so the switch stays focusable and its reason can be read.
  disabled?: boolean;
  description?: ReactNode;
  name?: string;
  value?: string;
}

// TODO(#58): React Aria Switch on a real checkbox, so a form posts without JS.
export const Switch: (props: SwitchProps) => ReactNode = () => null;
