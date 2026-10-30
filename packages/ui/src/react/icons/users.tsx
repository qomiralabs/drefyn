import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconUsers(props: IconProps): ReactNode {
  return (
    <Icon name="users" {...props}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20C3 16 5.5 14 9 14C12.5 14 15 16 15 20" />
      <path d="M15.5 4.8A3.5 3.5 0 0 1 15.5 11.2M17.5 14.4C19.6 15.2 21 17.2 21 20" />
    </Icon>
  );
}
