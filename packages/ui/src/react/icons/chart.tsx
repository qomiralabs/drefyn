import type { ReactNode } from 'react';
import { Icon, type IconProps } from './icon.tsx';

export function IconChart(props: IconProps): ReactNode {
  return (
    <Icon name="chart" {...props}>
      <path d="M4 4V20H20" />
      <path d="M8 16V12M12 16V8M16 16V11" />
    </Icon>
  );
}
