import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconPerson(props: IconProps): ReactNode {
  return (
    <Icon name="person" {...props}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21C4 16.5 7.5 14 12 14C16.5 14 20 16.5 20 21" />
    </Icon>
  );
}
