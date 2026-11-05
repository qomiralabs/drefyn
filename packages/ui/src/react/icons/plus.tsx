import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconPlus(props: IconProps): ReactNode {
  return (
    <Icon name="plus" {...props}>
      <path d="M12 4V20M4 12H20" />
    </Icon>
  );
}
