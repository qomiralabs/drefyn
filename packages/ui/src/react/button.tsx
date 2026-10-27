import type { ComponentPropsWithRef, ReactNode } from 'react';
import {
  buttonClasses,
  LABEL_CELL,
  type ButtonSize,
  type ButtonVariant,
} from './button-classes.ts';

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

// Handlers that would act on a press. A button that cannot act drops them all. Hover and
// focus handlers stay, so a tooltip can still say why it cannot act.
const PRESS =
  /^on(?:Click|DoubleClick|AuxClick|ContextMenu|(?:Pointer|Mouse)(?:Down|Up)|Touch(?:Start|End)|Key(?:Down|Up|Press))(?:Capture)?$/;

function withoutPress<T extends object>(props: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(props).filter(([name]) => !PRESS.test(name)),
  ) as Partial<T>;
}

// A native button with no hooks, so it renders on the server and works with JS off.
// Disabled and busy drop the click handler and render type="button": there is no script to
// cancel a submit, and that is the only way a focusable button cannot post its form.
export function Button({
  variant = 'secondary',
  size = 'md',
  type = 'button',
  disabled = false,
  busy = false,
  busyLabel,
  icon,
  children,
  ...props
}: ButtonProps): ReactNode {
  // The types refuse all three, so they arrive only from callers without types. A missing or
  // empty busy label would let the width jump, so it throws; an inline style would bypass the
  // tokens, so it is dropped.
  if (busyLabel?.trim() === '') throw new Error('Button needs a non empty busy label.');
  if (busy && busyLabel === undefined) throw new Error('A busy Button needs a busy label.');
  const rest: typeof props & { style?: undefined } = { ...props };
  delete rest.style;
  const inert = disabled || busy;
  const label = (
    <span data-label="rest" className={busy ? `${LABEL_CELL} invisible` : LABEL_CELL}>
      {icon}
      {children}
    </span>
  );
  return (
    <button
      {...(inert ? withoutPress(rest) : rest)}
      type={inert ? 'button' : type}
      aria-disabled={inert ? true : undefined}
      data-busy={busy ? '' : undefined}
      className={buttonClasses({ variant, size, disabled, busy })}
    >
      {label}
      {busyLabel === undefined ? null : (
        // visibility, not display or a visually hidden class: the hidden label keeps its
        // size and leaves the accessibility tree, so the name is only the visible label.
        <span data-label="busy" className={busy ? LABEL_CELL : `${LABEL_CELL} invisible`}>
          {busyLabel}
        </span>
      )}
    </button>
  );
}
