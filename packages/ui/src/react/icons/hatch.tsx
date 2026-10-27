import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconHatch(props: IconProps): ReactNode {
  return (
    <Icon name="hatch" {...props}>
      <rect x="4" y="4" width="16" height="16" />
      <path d="M4 12L12 4M4 20L20 4M12 20L20 12" />
    </Icon>
  );
}
