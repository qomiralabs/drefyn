'use client';
import type { ReactNode } from 'react';

export interface RadioProps {
  value: string;
  // The visible label.
  children: ReactNode;
  description?: ReactNode;
  // Stays reachable by the arrow keys, announces as unavailable and is never chosen.
  disabled?: boolean;
}

// TODO(#58): React Aria Radio inside our RadioGroup.
export const Radio: (props: RadioProps) => ReactNode = () => null;
