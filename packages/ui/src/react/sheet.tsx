'use client';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import { Dialog as AriaDialog, Heading, Modal, ModalOverlay } from 'react-aria-components';
import { tokens } from '../tokens/tokens.ts';
import { buttonClasses } from './button-classes.ts';
import { IconCross } from './icons/cross.tsx';

// The small breakpoint: Tailwind's sm, from the layout token, in rem so it follows zoom.
const WIDE = `(min-width: ${String(tokens.layout.compactBelow / 16)}rem)`;

const subscribe = (changed: () => void): (() => void) => {
  const query = window.matchMedia(WIDE);
  query.addEventListener('change', changed);
  return () => {
    query.removeEventListener('change', changed);
  };
};

// True below the small breakpoint. The server and the first client render assume a wide
// screen, since nothing opens until someone presses a trigger.
export function usePhone(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => !window.matchMedia(WIDE).matches,
    () => false,
  );
}

// Rows inside a sheet grow to the comfortable row, so they are easy to tap. React Aria
// renders collection rows from a hidden copy of its children, where no context of ours
// reaches, so rows size themselves from the sheet's data attribute instead.
export const ROW = 'min-h-row-compact in-data-sheet:min-h-row-comfortable';

// What a trigger says, for a sheet that has no title of its own. Read once when the trigger
// mounts, through a stable callback ref, so it cannot loop with the render it causes.
export function useTriggerText(): [(el: HTMLElement | null) => void, string] {
  const [text, setText] = useState('');
  const ref = useCallback((el: HTMLElement | null) => {
    if (el !== null) setText(el.textContent.trim());
  }, []);
  return [ref, text];
}

export interface SheetProps {
  // Shown at the top and naming the sheet.
  title: string;
  // The opener's own state, passed in so a sheet inside a dialog never takes the dialog's.
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // What opened it, where focus goes back when it closes.
  trigger: RefObject<HTMLElement | null>;
  children: ReactNode;
}

// React Aria returns focus when a sheet closes, but a sheet stacked over a dialog closed by a
// press sometimes left WebKit's focus on the dialog, whose own scope took it first. After
// React Aria has had its turn, focus left on the page or on the layer that holds the trigger
// goes to the trigger. Focus that moved on, such as into a dialog a menu item opened, stays.
function useReturnFocus(open: boolean, trigger: RefObject<HTMLElement | null>): void {
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    // Registered after React Aria's own restore, so it runs after it.
    const frame = requestAnimationFrame(() => {
      const target = trigger.current;
      const active = document.activeElement;
      if (target === null || !target.isConnected || active === target) return;
      if (active === null || active === document.body || active.contains(target)) target.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [open, trigger]);
}

// The bottom sheet that Select, Menu and Popover open in on a phone. Each keeps its own
// keyboard model: the list or menu takes focus, a popover's panel takes it otherwise.
// It is modal: the scrim dims the page, Tab stays inside, and Escape, a press on the scrim
// and Close all shut it and send focus back to the trigger. Over an open dialog it is the
// topmost layer, so those close it alone. The scrim fades on the duration token; the panel
// rises on the move token, which reduced motion sets to zero, leaving the fade.
export function Sheet({ title, open, onOpenChange, trigger, children }: SheetProps): ReactNode {
  useReturnFocus(open, trigger);
  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={onOpenChange}
      isDismissable
      // Only a press on the scrim closes it. The scrim covers the page, so that is every
      // press outside in a browser; it also keeps the press that opened the sheet from
      // landing outside it a moment later and closing it again.
      shouldCloseOnInteractOutside={(el) => el.hasAttribute('data-sheet')}
      data-sheet=""
      className="fixed inset-0 z-overlay flex items-end bg-overlay-scrim pt-48 transition-opacity duration-base ease-enter data-entering:opacity-0"
    >
      <Modal className="flex max-h-full w-full transition-transform duration-move-base ease-enter outline-none motion-safe:data-entering:translate-y-full">
        <AriaDialog className="relative flex max-h-full w-full flex-col rounded-t-md border border-b-0 border-rule-strong bg-overlay pb-safe-bottom text-body-s text-body shadow-2 outline-none">
          {({ close }) => (
            <>
              <div className="border-b border-rule ps-16 pe-48 pt-16 pb-12">
                <Heading slot="title" className="truncate text-title text-ink">
                  {title}
                </Heading>
              </div>
              <div className="flex min-h-0 flex-col overflow-y-auto p-8">{children}</div>
              {/* Last in the DOM, so Tab reaches the content first; drawn top right. */}
              <button
                type="button"
                aria-label="Close"
                onClick={close}
                className={`absolute end-12 top-16 ${buttonClasses({
                  variant: 'quiet',
                  size: 'sm',
                  disabled: false,
                  iconOnly: true,
                })}`}
              >
                <IconCross />
              </button>
            </>
          )}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}
