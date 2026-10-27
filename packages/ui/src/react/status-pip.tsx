import type { ReactNode } from 'react';
import { StateIcon } from './state-icon.tsx';
import type { State } from './state.ts';

export interface StatusPipProps {
  state: State;
  // The accessible name, since a pip shows no word.
  label: string;
}

// The state shape alone, for places too dense for a word. It is an image named by its
// label, so a screen reader hears the state and a sighted reader sees the shape.
export function StatusPip({ state, label }: StatusPipProps): ReactNode {
  return (
    <span role="img" aria-label={label} data-state={state} className="inline-flex shrink-0">
      <StateIcon state={state} />
    </span>
  );
}
