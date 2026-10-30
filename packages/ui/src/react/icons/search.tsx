import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconSearch(props: IconProps): ReactNode {
  return (
    <Icon name="search" {...props}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.1 15.1L21 21" />
    </Icon>
  );
}
