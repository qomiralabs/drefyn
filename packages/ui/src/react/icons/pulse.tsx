import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconPulse(props: IconProps): ReactNode {
  return (
    <Icon name="pulse" {...props}>
      <path d="M3 12H7.5L10 6L14 18L16.5 12H21" />
    </Icon>
  );
}
