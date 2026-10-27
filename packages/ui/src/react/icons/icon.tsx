import type { ReactNode } from 'react';

export interface IconProps {
  size?: 'sm' | 'md' | 'lg';
  // Names the icon for screen readers. Without it the icon is decorative.
  label?: string;
}

export interface IconShape extends IconProps {
  // Kebab case name, rendered as data-icon.
  name: string;
  // Shapes on the 24 unit grid.
  children: ReactNode;
}

// TODO(#58): the shared svg frame: 24 grid, stroke from the token, square terminals, no fill.
export const Icon: (props: IconShape) => ReactNode = () => null;
