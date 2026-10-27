import type { ReactNode } from 'react';
import { checkShape } from './icons/check.tsx';
import { clockShape } from './icons/clock.tsx';
import { crossShape } from './icons/cross.tsx';
import { hatchShape } from './icons/hatch.tsx';
import { Icon } from './icons/icon.tsx';
import type { State } from './state.ts';

// Each state has its own shape, so state never rests on colour alone.
const SHAPE: Record<State, { name: string; shape: ReactNode }> = {
  fresh: { name: 'check', shape: checkShape },
  stale: { name: 'clock', shape: clockShape },
  broken: { name: 'cross', shape: crossShape },
  neutral: { name: 'hatch', shape: hatchShape },
};

// The state mark used by Badge and StatusPip. Decorative: the word or the pip's name
// carries the meaning.
export function StateIcon({ state }: { state: State }): ReactNode {
  const { name, shape } = SHAPE[state];
  return (
    <Icon name={name} tone={state}>
      {shape}
    </Icon>
  );
}
