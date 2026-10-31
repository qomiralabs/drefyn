import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconInbox(props: IconProps): ReactNode {
  return (
    <Icon name="inbox" {...props}>
      <path d="M3 13L6 5H18L21 13V19H3Z" />
      <path d="M3 13H8L9.5 15.5H14.5L16 13H21" />
    </Icon>
  );
}
