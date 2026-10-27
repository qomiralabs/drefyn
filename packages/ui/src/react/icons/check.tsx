import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

// The shape alone, so components in this package can paint it in a state colour.
export const checkShape = <path d="M4 12.5L9.5 18L20 6" />;

export function IconCheck(props: IconProps): ReactNode {
  return (
    <Icon name="check" {...props}>
      {checkShape}
    </Icon>
  );
}
