import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconLink(props: IconProps): ReactNode {
  return (
    <Icon name="link" {...props}>
      <path d="M9 15L15 9" />
      <path d="M11 6L13 4C14.7 2.3 17.3 2.3 19 4L20 5C21.7 6.7 21.7 9.3 20 11L18 13" />
      <path d="M13 18L11 20C9.3 21.7 6.7 21.7 5 20L4 19C2.3 17.3 2.3 14.7 4 13L6 11" />
    </Icon>
  );
}
