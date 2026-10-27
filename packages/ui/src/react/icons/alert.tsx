import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

// The shape alone, so components in this package can paint it in a state colour.
export const alertShape = (
  <>
    <path d="M12 3L22 20H2Z" />
    <path d="M12 9V14M12 16.5V18" />
  </>
);

export function IconAlert(props: IconProps): ReactNode {
  return (
    <Icon name="alert" {...props}>
      {alertShape}
    </Icon>
  );
}
