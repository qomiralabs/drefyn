'use client';
import { Tooltip } from '@drefyn/ui/react';
import type { ReactElement, ReactNode, RefObject } from 'react';

export interface RailTipProps {
  label: RefObject<HTMLElement | null>;
  text: string;
  children: ReactElement;
}

// On the rail a label is visually hidden, which takes it out of the flow. Asking the label
// rather than the width covers incident mode too, which puts wide screens on the rail.
const offScreen = (label: RefObject<HTMLElement | null>) => () =>
  label.current !== null && getComputedStyle(label.current).position === 'absolute';

// The rail shows a label beside its icon on hover and keyboard focus. The link's name stays
// the hidden label, so the tooltip only repeats it for sighted people.
export function RailTip({ label, text, children }: RailTipProps): ReactNode {
  return (
    <Tooltip content={text} placement="end" repeats when={offScreen(label)}>
      {children}
    </Tooltip>
  );
}
