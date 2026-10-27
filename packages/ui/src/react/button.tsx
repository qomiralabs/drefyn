import type { ComponentPropsWithRef, ReactNode } from 'react';
import type { ButtonSize, ButtonVariant } from './button-classes.ts';

export interface ButtonProps extends Omit<
  ComponentPropsWithRef<'button'>,
  'className' | 'style' | 'disabled' | 'type'
> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  type?: 'button' | 'submit' | 'reset';
  // Rendered as aria-disabled so the control stays focusable and its reason can be read.
  disabled?: boolean;
  // The label shows the verb in progress; the button ignores activation until it is done.
  busy?: boolean;
  icon?: ReactNode;
  children: ReactNode;
}

// TODO(#58): native button, server safe.
export const Button: (props: ButtonProps) => ReactNode = () => null;
