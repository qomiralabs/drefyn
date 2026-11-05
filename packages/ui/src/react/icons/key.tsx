import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconKey(props: IconProps): ReactNode {
  return (
    <Icon name="key" {...props}>
      <circle cx="8" cy="16" r="4" />
      <path d="M11 13L20 4M16.5 7.5L19 10M14 10L16 12" />
    </Icon>
  );
}
