import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconLaptop(props: IconProps): ReactNode {
  return (
    <Icon name="laptop" {...props}>
      <rect x="4" y="5" width="16" height="11" />
      <path d="M2 19H22" />
    </Icon>
  );
}
