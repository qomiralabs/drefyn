'use client';
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger,
  Heading,
  Popover as AriaPopover,
} from 'react-aria-components';
import { buttonClasses, LABEL_CELL, type ButtonSize } from './button-classes.ts';

interface PopoverBase {
  // What the trigger shows.
  trigger: ReactNode;
  // The trigger's accessible name when it shows only an icon.
  triggerLabel?: string;
  variant?: 'secondary' | 'quiet';
  size?: ButtonSize;
  // A heading that names the panel. Without it the trigger names the panel.
  title?: string;
  // The panel's content.
  children: ReactNode;
  placement?: 'bottom start' | 'bottom end' | 'top start' | 'top end';
}

// The popover keeps its own open state, or the caller holds it. A caller that holds open must
// hear when it closes, or Escape and a click outside would do nothing.
interface OwnState {
  open?: never;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}
interface HeldState {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultOpen?: never;
}

export type PopoverProps = PopoverBase & (OwnState | HeldState);

const TABBABLE =
  'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// The panel's own stops, leaving out React Aria's hidden dismiss buttons and anything inert.
const stopsIn = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (el) => el.tabIndex >= 0 && el.closest('[inert]') === null,
  );

// A trigger styled by the button class function and a non modal panel on the overlay
// surface, so the rest of the page stays readable and usable while it is open. Focus moves
// into the panel, which reads its heading. The panel renders at the end of the page, so
// leaving it by Tab would land somewhere unrelated: Tab past the last control closes it and
// moves on from the trigger, and Shift+Tab before the first closes it on the trigger, as if
// the panel sat right after its trigger. Escape and a press outside close it too.
export function Popover(props: PopoverProps): ReactNode {
  const {
    trigger,
    triggerLabel,
    variant = 'secondary',
    size = 'md',
    title,
    children,
    placement = 'bottom start',
    onOpenChange,
  } = props;
  const [own, setOwn] = useState(props.defaultOpen ?? false);
  const held = props.open !== undefined;
  const open = props.open ?? own;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const change = (next: boolean) => {
    if (!held) setOwn(next);
    onOpenChange?.(next);
  };
  // Closing synchronously unmounts the panel before focus moves, so the browser's own Tab
  // runs from the trigger.
  const closeNow = useEffectEvent(() => {
    flushSync(() => {
      change(false);
    });
  });

  useEffect(() => {
    if (!open) return;
    // React Aria handles Tab on the document; the window's capture phase runs first. Option
    // counts as Tab, since Safari moves to buttons only with it held.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.ctrlKey || event.metaKey) return;
      const panel = panelRef.current;
      const active = document.activeElement;
      if (panel === null || !(active instanceof HTMLElement) || !panel.contains(active)) return;
      const stops = stopsIn(panel);
      const back = event.shiftKey && (active === panel || active === stops[0]);
      const forward = !event.shiftKey && (stops.length === 0 || active === stops.at(-1));
      if (!back && !forward) return;
      closeNow();
      triggerRef.current?.focus();
      // Backwards ends on the trigger; forwards lets the browser's Tab run on from it.
      if (back) event.preventDefault();
    };
    // A non modal popover in React Aria closes only when focus moves to another control, so a
    // press on the page itself is caught here. Presses on the trigger are its own toggle.
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target) === true) return;
      if (triggerRef.current?.contains(target) === true) return;
      closeNow();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open]);

  const iconOnly = triggerLabel !== undefined;
  return (
    <DialogTrigger isOpen={open} onOpenChange={change}>
      <AriaButton
        ref={triggerRef}
        aria-haspopup="dialog"
        {...(iconOnly ? { 'aria-label': triggerLabel } : {})}
        className={`${buttonClasses({ variant, size, disabled: false, iconOnly })} aria-expanded:bg-pressed`}
      >
        <span className={LABEL_CELL}>{trigger}</span>
      </AriaButton>
      {/* Fades in on the duration token and travels the enter distance away from the trigger;
          under reduced motion only the fade is left. */}
      <AriaPopover
        isNonModal
        // Focus moving to the trigger is the start of its own toggle, not a reason to close;
        // closing here would let the press open the panel again.
        shouldCloseOnInteractOutside={(el) => triggerRef.current?.contains(el) !== true}
        placement={placement}
        offset={4}
        data-popover=""
        className="z-overlay max-w-measure rounded-md border border-rule-strong bg-overlay shadow-1 transition duration-base ease-enter data-entering:opacity-0 motion-safe:data-entering:-translate-y-4 motion-safe:data-[placement=top]:data-entering:translate-y-4"
      >
        <AriaDialog
          ref={panelRef}
          className="flex flex-col gap-12 p-16 text-body-s text-body outline-none"
        >
          {title === undefined ? null : (
            <Heading slot="title" className="text-body-s font-medium text-ink">
              {title}
            </Heading>
          )}
          {children}
        </AriaDialog>
      </AriaPopover>
    </DialogTrigger>
  );
}
