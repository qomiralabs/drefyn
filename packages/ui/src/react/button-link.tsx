import type { ComponentPropsWithRef, ReactNode } from 'react';
import type { ButtonSize, ButtonVariant } from './button-classes.ts';

export interface ButtonLinkProps extends Omit<ComponentPropsWithRef<'a'>, 'className' | 'style'> {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  children: ReactNode;
}

// TODO(#58): an anchor styled by the button class function, server safe.
export const ButtonLink: (props: ButtonLinkProps) => ReactNode = () => null;
