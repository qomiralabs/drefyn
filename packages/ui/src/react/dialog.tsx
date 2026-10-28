'use client';
import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger,
  Heading,
  Modal,
  ModalOverlay,
} from 'react-aria-components';
import {
  buttonClasses,
  LABEL_CELL,
  type ButtonSize,
  type ButtonVariant,
} from './button-classes.ts';
import { alertShape } from './icons/alert.tsx';
import { IconCross } from './icons/cross.tsx';
import { Icon } from './icons/icon.tsx';

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

const FIELD = 'input:not([type="hidden"]), textarea, select';

// Focus goes to the first field, so a form starts where typing starts. With no field React
// Aria focuses the dialog itself, which reads its title. This renders after the dialog, so
// its effect runs after React Aria's and has the last word.
function FirstField({ panel }: { panel: RefObject<HTMLElement | null> }): ReactNode {
  useEffect(() => {
    // A dialog that opens on a failed submit starts on the message instead.
    const start =
      panel.current?.querySelector<HTMLElement>('[data-submit-error]') ??
      panel.current?.querySelector<HTMLElement>(FIELD);
    start?.focus();
  }, [panel]);
  return null;
}

const TABBABLE =
  'a[href], button, input:not([type="hidden"]), textarea, select, [tabindex]:not([tabindex="-1"])';

// React Aria keeps Tab inside the dialog but lets Option+Tab through, and Safari moves to
// buttons only with Option held, so at either end that key would leave the dialog. This
// wraps it at the ends, as React Aria does for Tab, and leaves every other step to the
// browser.
function OptionTabWrap({ panel }: { panel: RefObject<HTMLElement | null> }): ReactNode {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !event.altKey || event.ctrlKey || event.metaKey) return;
      const root = panel.current;
      if (!root?.contains(document.activeElement)) return;
      const stops = [...root.querySelectorAll<HTMLElement>(TABBABLE)];
      const first = stops[0];
      const last = stops.at(-1);
      if (first === undefined || last === undefined) return;
      const edge = event.shiftKey ? first : last;
      if (document.activeElement !== edge && document.activeElement !== root) return;
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [panel]);
  return null;
}

// React Aria's dialog drops aria-busy from its props, so it is written on the element.
function Busy({ panel, busy }: { panel: RefObject<HTMLElement | null>; busy: boolean }): ReactNode {
  useEffect(() => {
    if (busy) panel.current?.setAttribute('aria-busy', 'true');
    else panel.current?.removeAttribute('aria-busy');
  }, [panel, busy]);
  return null;
}

// A failed submit takes focus when it appears, so the reader hears it first, and it sits
// before the fields, so the next Tab is the first field. Not a live region: the focus move
// is the announcement.
function SubmitError({ children }: { children: string }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [children]);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      data-submit-error=""
      className="flex items-start gap-8 text-state-broken-text outline-none focus-visible:focus-ring"
    >
      <span className="flex h-row-compact shrink-0 items-center">
        <Icon name="alert" tone="broken">
          {alertShape}
        </Icon>
      </span>
      <span className="py-4">{children}</span>
    </div>
  );
}

// The scrim dims the page; below 640 px the panel rises from the bottom edge as a sheet and
// clears the device's safe area. A click outside never closes it, so typed input survives a
// stray tap.
export function Dialog(props: DialogProps): ReactNode {
  const { title, description, children, footer, busy = false, error, onOpenChange } = props;
  if (title.trim() === '') throw new Error('A Dialog needs a title to name it.');
  const descriptionId = useId();
  const panel = useRef<HTMLElement>(null);
  const failed = error !== undefined && error.trim() !== '';
  const held = {
    ...(props.open === undefined ? {} : { isOpen: props.open }),
    ...(onOpenChange === undefined ? {} : { onOpenChange }),
  };
  const overlay = (
    <ModalOverlay
      isDismissable={false}
      isKeyboardDismissDisabled={busy}
      {...(props.trigger === undefined ? held : {})}
      className="fixed inset-0 z-overlay flex items-end justify-center bg-overlay-scrim pt-48 sm:items-center sm:p-24"
    >
      <Modal className="flex max-h-full w-full outline-none sm:max-w-measure">
        <AriaDialog
          ref={panel}
          {...(description === undefined ? {} : { 'aria-describedby': descriptionId })}
          className="relative flex max-h-full w-full flex-col rounded-t-md border border-rule-strong bg-overlay pb-safe-bottom text-body-s text-body shadow-2 outline-none sm:rounded-md sm:pb-0"
        >
          {({ close }) => {
            const closeUnlessBusy = () => {
              if (!busy) close();
            };
            return (
              <>
                <div className="flex flex-col gap-4 ps-16 pe-48 pt-16 sm:ps-24 sm:pt-24">
                  <Heading slot="title" className="text-title text-ink">
                    {title}
                  </Heading>
                  {description === undefined ? null : (
                    <p id={descriptionId} className="max-w-measure text-secondary">
                      {description}
                    </p>
                  )}
                </div>
                <div className="flex min-h-0 flex-col gap-16 overflow-y-auto px-16 py-16 sm:px-24">
                  {failed ? <SubmitError>{error}</SubmitError> : null}
                  {children}
                </div>
                {footer === undefined ? null : (
                  <div className="flex flex-wrap justify-end gap-8 border-t border-rule px-16 py-12 sm:px-24">
                    {typeof footer === 'function' ? footer(closeUnlessBusy) : footer}
                  </div>
                )}
                {/* Last in the DOM, so Tab reaches the fields first; drawn top right. */}
                <button
                  type="button"
                  aria-label="Close"
                  aria-disabled={busy ? true : undefined}
                  onClick={busy ? undefined : close}
                  className={`absolute end-12 top-16 sm:end-16 sm:top-24 ${buttonClasses({
                    variant: 'quiet',
                    size: 'sm',
                    disabled: busy,
                    iconOnly: true,
                  })}`}
                >
                  <IconCross />
                </button>
              </>
            );
          }}
        </AriaDialog>
        <FirstField panel={panel} />
        <Busy panel={panel} busy={busy} />
        <OptionTabWrap panel={panel} />
      </Modal>
    </ModalOverlay>
  );
  if (props.trigger === undefined) return overlay;
  const iconOnly = props.triggerLabel !== undefined;
  return (
    <DialogTrigger
      {...held}
      {...(props.defaultOpen === undefined ? {} : { defaultOpen: props.defaultOpen })}
    >
      <AriaButton
        // React Aria leaves this off modal triggers; it tells a reader what the press opens.
        aria-haspopup="dialog"
        {...(iconOnly ? { 'aria-label': props.triggerLabel } : {})}
        className={buttonClasses({
          variant: props.variant ?? 'secondary',
          size: props.size ?? 'md',
          disabled: false,
          iconOnly,
        })}
      >
        <span className={LABEL_CELL}>{props.trigger}</span>
      </AriaButton>
      {overlay}
    </DialogTrigger>
  );
}
