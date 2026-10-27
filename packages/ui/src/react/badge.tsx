import type { ReactNode } from 'react';
import type { State } from './state.ts';

export interface BadgeProps {
  state: State;
  // The state word, always visible.
  children: ReactNode;
  // Set when the badge sits on anything that can be hovered, pressed or selected.
  onFill?: boolean;
}

// TODO(#58): state icon plus word, server safe.
export const Badge: (props: BadgeProps) => ReactNode = () => null;
