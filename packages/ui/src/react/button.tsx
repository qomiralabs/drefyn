import type { ComponentPropsWithRef, ReactNode } from 'react';
import type { ButtonSize, ButtonVariant } from './button-classes.ts';

interface ButtonBase extends Omit<
  ComponentPropsWithRef<'button'>,
  'className' | 'style' | 'disabled' | 'type'
> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  type?: 'button' | 'submit' | 'reset';
  // Rendered as aria-disabled so the control stays focusable and its reason can be read.
  disabled?: boolean;
  icon?: ReactNode;
  // The label at rest.
  children: ReactNode;
}

// A button that can ever be busy always passes its busy label, so both labels share one
// cell and the width never changes, even with JS off. While busy the button keeps its
// variant's paint, renders data-busy and ignores activation.
export type ButtonProps = ButtonBase &
  ({ busy?: never; busyLabel?: never } | { busy?: boolean; busyLabel: string });

// TODO(#58): native button, server safe.
export const Button: (props: ButtonProps) => ReactNode = () => null;
