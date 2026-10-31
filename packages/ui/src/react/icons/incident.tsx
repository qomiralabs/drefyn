import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconIncident(props: IconProps): ReactNode {
  return (
    <Icon name="incident" {...props}>
      <path d="M12 3L22 20H2Z" />
      <path d="M12 9V14M12 16.5V18" />
    </Icon>
  );
}
