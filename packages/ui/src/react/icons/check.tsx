import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconCheck(props: IconProps): ReactNode {
  return (
    <Icon name="check" {...props}>
      <path d="M4 12.5L9.5 18L20 6" />
    </Icon>
  );
}
