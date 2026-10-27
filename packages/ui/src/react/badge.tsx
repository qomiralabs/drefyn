import type { ReactNode } from 'react';
import { StateIcon } from './state-icon.tsx';
import { requireWord, type State } from './state.ts';

export interface BadgeProps {
  state: State;
  // The state word, always visible. A string, so it can never be empty markup; an empty
  // word throws.
  children: string;
  // Set when the badge sits on anything that can be hovered, pressed or selected.
  onFill?: boolean;
}

const WORD: Record<State, string> = {
  fresh: 'text-state-fresh-text',
  stale: 'text-state-stale-text',
  broken: 'text-state-broken-text',
  neutral: 'text-state-neutral-text',
};

// State text colours fail on the hover and pressed fills, so on a fill the word turns to
// body text and the icon keeps its colour.
export function Badge({ state, children, onFill = false }: BadgeProps): ReactNode {
  const word = requireWord('Badge', children);
  const colour = onFill ? 'text-body' : WORD[state];
  return (
    <span data-state={state} className={`inline-flex items-center gap-4 text-body-s ${colour}`}>
      <StateIcon state={state} />
      {word}
    </span>
  );
}
