import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconGlobe(props: IconProps): ReactNode {
  return (
    <Icon name="globe" {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <ellipse cx="12" cy="12" rx="3.5" ry="8.5" />
      <path d="M3.5 12H20.5" />
    </Icon>
  );
}
