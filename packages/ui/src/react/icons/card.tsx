import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconCard(props: IconProps): ReactNode {
  return (
    <Icon name="card" {...props}>
      <rect x="3" y="5" width="18" height="14" />
      <path d="M3 10H21M6 15H10" />
    </Icon>
  );
}
