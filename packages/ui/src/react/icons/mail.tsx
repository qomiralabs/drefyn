import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconMail(props: IconProps): ReactNode {
  return (
    <Icon name="mail" {...props}>
      <rect x="3" y="5" width="18" height="14" />
      <path d="M3 6L12 13L21 6" />
    </Icon>
  );
}
