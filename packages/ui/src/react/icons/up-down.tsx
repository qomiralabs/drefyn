import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconUpDown(props: IconProps): ReactNode {
  return (
    <Icon name="up-down" {...props}>
      <path d="M8 9L12 5L16 9M8 15L12 19L16 15" />
    </Icon>
  );
}
