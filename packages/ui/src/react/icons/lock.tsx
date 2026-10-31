import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconLock(props: IconProps): ReactNode {
  return (
    <Icon name="lock" {...props}>
      <rect x="5" y="11" width="14" height="10" />
      <path d="M8 11V6H16V11" />
    </Icon>
  );
}
