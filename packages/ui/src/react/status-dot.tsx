import type { ReactNode } from 'react';
import type { State } from './state.ts';

export interface StatusDotProps {
  state: State | 'live';
  // The word beside the dot, always visible: amber and teal dots never stand alone. An empty
  // word throws.
  children: string;
}

// TODO(#58): a static dot beside a word, server safe.
export const StatusDot: (props: StatusDotProps) => ReactNode = () => null;
