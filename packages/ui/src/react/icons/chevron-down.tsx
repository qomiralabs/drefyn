import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconChevronDown(props: IconProps): ReactNode {
  return (
    <Icon name="chevron-down" {...props}>
      <path d="M6 9L12 15L18 9" />
    </Icon>
  );
}
