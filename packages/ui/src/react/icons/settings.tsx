import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconSettings(props: IconProps): ReactNode {
  return (
    <Icon name="settings" {...props}>
      <path d="M4 7H14M18 7H20M4 17H6M10 17H20" />
      <rect x="14" y="5" width="4" height="4" />
      <rect x="6" y="15" width="4" height="4" />
    </Icon>
  );
}
