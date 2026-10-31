import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconHome(props: IconProps): ReactNode {
  return (
    <Icon name="home" {...props}>
      <path d="M4 11L12 4L20 11" />
      <path d="M6 9.5V20H18V9.5" />
    </Icon>
  );
}
