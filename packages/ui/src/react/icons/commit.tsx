import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconCommit(props: IconProps): ReactNode {
  return (
    <Icon name="commit" {...props}>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M3 12H8.5M15.5 12H21" />
    </Icon>
  );
}
