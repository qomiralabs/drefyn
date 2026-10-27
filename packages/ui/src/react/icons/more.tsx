import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

// The shape alone, so components in this package can paint it in a state colour.
export const moreShape = <path d="M5 12H7M11 12H13M17 12H19" />;

export function IconMore(props: IconProps): ReactNode {
  return (
    <Icon name="more" {...props}>
      {moreShape}
    </Icon>
  );
}
