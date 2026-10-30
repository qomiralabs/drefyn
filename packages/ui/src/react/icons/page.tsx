import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconPage(props: IconProps): ReactNode {
  return (
    <Icon name="page" {...props}>
      <rect x="5" y="3" width="14" height="18" />
      <path d="M8 9H16M8 13H16M8 17H12" />
    </Icon>
  );
}
