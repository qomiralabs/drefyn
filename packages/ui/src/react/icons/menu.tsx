import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconMenu(props: IconProps): ReactNode {
  return (
    <Icon name="menu" {...props}>
      <path d="M4 7H20M4 12H20M4 17H20" />
    </Icon>
  );
}
