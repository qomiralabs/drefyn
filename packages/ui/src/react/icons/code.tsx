import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconCode(props: IconProps): ReactNode {
  return (
    <Icon name="code" {...props}>
      <path d="M8 6L3 12L8 18" />
      <path d="M16 6L21 12L16 18" />
      <path d="M13.5 5L10.5 19" />
    </Icon>
  );
}
