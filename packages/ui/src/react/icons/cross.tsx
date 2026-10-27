import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

// The shape alone, so components in this package can paint it in a state colour.
export const crossShape = <path d="M5 5L19 19M19 5L5 19" />;

export function IconCross(props: IconProps): ReactNode {
  return (
    <Icon name="cross" {...props}>
      {crossShape}
    </Icon>
  );
}
