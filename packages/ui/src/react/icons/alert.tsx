import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconAlert(props: IconProps): ReactNode {
  return (
    <Icon name="alert" {...props}>
      <path d="M12 3L22 20H2Z" />
      <path d="M12 9V14M12 16.5V18" />
    </Icon>
  );
}
