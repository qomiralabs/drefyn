import type { ComponentPropsWithRef, ReactNode } from 'react';

export interface TextFieldProps extends Omit<
  ComponentPropsWithRef<'input'>,
  'className' | 'style' | 'size' | 'disabled' | 'onChange' | 'type' | 'id' | 'children'
> {
  // Required, so the label, description and error can be wired without a hook.
  id: string;
  label: string;
  description?: ReactNode;
  // The message for an invalid value. Setting it marks the field invalid.
  error?: string;
  type?: 'text' | 'email' | 'url' | 'password' | 'search' | 'tel';
  size?: 'md' | 'lg';
  // Rendered as aria-disabled and read only, so the field stays focusable.
  disabled?: boolean;
  onChange?: (value: string) => void;
}

// TODO(#58): a native input with its label, description and error.
export const TextField: (props: TextFieldProps) => ReactNode = () => null;
