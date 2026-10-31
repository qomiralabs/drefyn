import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconSchema(props: IconProps): ReactNode {
  return (
    <Icon name="schema" {...props}>
      <rect x="3" y="4" width="8" height="6" />
      <rect x="13" y="14" width="8" height="6" />
      <path d="M7 10V17H13" />
    </Icon>
  );
}
