'use client';
import type { ReactNode } from 'react';
import type { ButtonSize, ButtonVariant } from './button-classes.ts';

interface DialogBase {
  title: string;
  description?: string;
  // The body.
  children: ReactNode;
  // Actions, right aligned under the body. A function gets the close callback.
  footer?: ReactNode | ((close: () => void) => ReactNode);
  // A submit is in flight: Escape and the close button do nothing until it ends.
  busy?: boolean;
  // Why the last submit failed, shown at the top of the body. Focus moves to it.
  error?: string;
  onOpenChange?: (open: boolean) => void;
}

// Either a trigger the dialog draws, or open state the caller holds, or both.
export type DialogProps = DialogBase &
  (
    | {
        trigger: ReactNode;
        triggerLabel?: string;
        variant?: ButtonVariant;
        size?: ButtonSize;
        open?: boolean;
        defaultOpen?: boolean;
      }
    | {
        trigger?: never;
        triggerLabel?: never;
        variant?: never;
        size?: never;
        open: boolean;
        defaultOpen?: never;
      }
  );

// TODO(#58): React Aria DialogTrigger, ModalOverlay, Modal and Dialog.
export const Dialog: (props: DialogProps) => ReactNode = () => null;
