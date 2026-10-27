import type { ReactNode } from 'react';
import { requireWord, type State } from './state.ts';

export interface StatusDotProps {
  state: State | 'live';
  // The word beside the dot, always visible: amber and teal dots never stand alone. An empty
  // word throws.
  children: string;
}

const DOT: Record<State | 'live', string> = {
  fresh: 'bg-state-fresh-mark',
  stale: 'bg-state-stale-mark',
  broken: 'bg-state-broken-mark',
  neutral: 'bg-state-neutral-mark',
  live: 'bg-signal-mark',
};

// Static on purpose: nothing in the brand pulses, and the word says what is happening.
export function StatusDot({ state, children }: StatusDotProps): ReactNode {
  const word = requireWord('StatusDot', children);
  return (
    <span data-state={state} className="inline-flex items-center gap-8 text-body">
      <span aria-hidden="true" className={`size-8 shrink-0 rounded-full ${DOT[state]}`} />
      {word}
    </span>
  );
}
