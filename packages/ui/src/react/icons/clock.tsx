import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

// The shape alone, so components in this package can paint it in a state colour.
export const clockShape = (
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7V12H16" />
  </>
);

export function IconClock(props: IconProps): ReactNode {
  return (
    <Icon name="clock" {...props}>
      {clockShape}
    </Icon>
  );
}
