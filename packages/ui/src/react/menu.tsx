'use client';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { Button, Menu as AriaMenu, MenuTrigger, Popover } from 'react-aria-components';
import { buttonClasses, LABEL_CELL, type ButtonShape, type ButtonSize } from './button-classes.ts';

export interface MenuProps {
  // What the trigger shows.
  trigger: ReactNode;
  // The trigger's accessible name when it shows only an icon.
  triggerLabel?: string;
  variant?: 'secondary' | 'quiet';
  size?: ButtonSize;
  // Round when the trigger is a circle, such as initials; its edge, hover and open fills
  // then follow the circle.
  triggerShape?: ButtonShape;
  // The menu's accessible name; the trigger names it when this is not set.
  label?: string;
  onAction?: (id: string) => void;
  defaultOpen?: boolean;
  children: ReactNode;
}

// React Aria skips disabled items in arrow navigation unless the collection's disabled
// behaviour is 'selection'. Menus do not type the prop, but pass it to their selection
// state, which honours it. Items still get aria-disabled and ignore activation.
const REACHABLE_WHEN_DISABLED = { disabledBehavior: 'selection' } as Record<string, unknown>;

// A trigger styled by the button class function, a popover on the overlay surface and a
// React Aria menu. The trigger shows the pressed fill while the menu is open.
export function Menu({
  trigger,
  triggerLabel,
  variant = 'secondary',
  size = 'md',
  triggerShape = 'square',
  label,
  onAction,
  defaultOpen = false,
  children,
}: MenuProps): ReactNode {
  const iconOnly = triggerLabel !== undefined;
  const labelId = useId();
  const [open, setOpen] = useState(defaultOpen);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLElement>(null);

  // Tab and Shift+Tab close the menu and move on from the trigger, as if it had never opened,
  // so a keyboard user keeps their place. React Aria handles Tab on the document in the
  // capture phase and stops it there, steering focus to the end of the modal popover, so
  // this listens on the window, which runs first. Closing synchronously unmounts the popover,
  // and React Aria's listener with it; focus goes back to the trigger and the browser's own
  // Tab runs from there.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Option+Tab is how Safari moves to buttons by default, so it counts as Tab here.
      if (event.key !== 'Tab' || event.ctrlKey || event.metaKey) return;
      if (popoverRef.current?.contains(document.activeElement) !== true) return;
      flushSync(() => {
        setOpen(false);
      });
      triggerRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);
  return (
    <MenuTrigger isOpen={open} onOpenChange={setOpen}>
      <Button
        ref={triggerRef}
        {...(iconOnly ? { 'aria-label': triggerLabel } : {})}
        className={`${buttonClasses({ variant, size, disabled: false, iconOnly, shape: triggerShape })} aria-expanded:bg-pressed`}
      >
        <span className={LABEL_CELL}>{trigger}</span>
      </Button>
      <Popover
        ref={popoverRef}
        placement="bottom start"
        offset={4}
        className="z-overlay min-w-128 overflow-auto rounded-md border border-rule-strong bg-overlay p-4 shadow-1"
      >
        <AriaMenu
          {...REACHABLE_WHEN_DISABLED}
          // React Aria names the menu by its trigger, and an undefined prop does not override
          // that, so a label of its own is a hidden element the menu points at instead.
          {...(label === undefined ? {} : { 'aria-labelledby': labelId })}
          {...(onAction === undefined
            ? {}
            : {
                onAction: (key) => {
                  onAction(String(key));
                },
              })}
          className="flex flex-col outline-none"
        >
          {children}
        </AriaMenu>
        {label === undefined ? null : (
          <span id={labelId} hidden>
            {label}
          </span>
        )}
      </Popover>
    </MenuTrigger>
  );
}
