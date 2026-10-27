import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconMore(props: IconProps): ReactNode {
  return (
    <Icon name="more" {...props}>
      <path d="M5 12H7M11 12H13M17 12H19" />
    </Icon>
  );
}
