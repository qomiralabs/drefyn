import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

// The shape alone, so components in this package can paint it in a state colour.
export const chevronDownShape = <path d="M6 9L12 15L18 9" />;

export function IconChevronDown(props: IconProps): ReactNode {
  return (
    <Icon name="chevron-down" {...props}>
      {chevronDownShape}
    </Icon>
  );
}
