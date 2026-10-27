import type { ReactNode } from 'react';
import type { State } from './state.ts';

export interface StatusPipProps {
  state: State;
  // The accessible name, since a pip shows no word.
  label: string;
}

// TODO(#58): the state shape alone, named for screen readers, server safe.
export const StatusPip: (props: StatusPipProps) => ReactNode = () => null;
