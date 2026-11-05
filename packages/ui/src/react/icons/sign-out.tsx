import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconSignOut(props: IconProps): ReactNode {
  return (
    <Icon name="sign-out" {...props}>
      <path d="M10 4H4V20H10" />
      <path d="M14 8L18 12L14 16M18 12H9" />
    </Icon>
  );
}
