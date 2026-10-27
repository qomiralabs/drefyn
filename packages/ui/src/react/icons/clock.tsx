import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconClock(props: IconProps): ReactNode {
  return (
    <Icon name="clock" {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7V12H16" />
    </Icon>
  );
}
