import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconCross(props: IconProps): ReactNode {
  return (
    <Icon name="cross" {...props}>
      <path d="M5 5L19 19M19 5L5 19" />
    </Icon>
  );
}
