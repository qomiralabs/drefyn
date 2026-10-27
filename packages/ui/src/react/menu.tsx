'use client';
import { useId, useState, type ReactNode } from 'react';
import { Button, Menu as AriaMenu, MenuTrigger, Popover } from 'react-aria-components';
import { buttonClasses, LABEL_CELL, type ButtonSize } from './button-classes.ts';

export interface MenuProps {
  // What the trigger shows.
  trigger: ReactNode;
  // The trigger's accessible name when it shows only an icon.
  triggerLabel?: string;
  variant?: 'secondary' | 'quiet';
  size?: ButtonSize;
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
  label,
  onAction,
  defaultOpen = false,
  children,
}: MenuProps): ReactNode {
  const iconOnly = triggerLabel !== undefined;
  const labelId = useId();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <MenuTrigger isOpen={open} onOpenChange={setOpen}>
      <Button
        {...(iconOnly ? { 'aria-label': triggerLabel } : {})}
        className={`${buttonClasses({ variant, size, disabled: false, iconOnly })} aria-expanded:bg-pressed`}
      >
        <span className={LABEL_CELL}>{trigger}</span>
      </Button>
      <Popover
        placement="bottom start"
        offset={4}
        className="z-overlay min-w-128 overflow-auto rounded-md border border-rule-strong bg-overlay p-4 shadow-1"
      >
        {/* The popover keeps focus inside while open, so Tab would cycle through the items.
            Tab leaves a menu instead, without running anything. React Aria's menu takes no
            key handler, and lets Tab bubble to this wrapper. */}
        <div
          className="contents"
          onKeyDown={(event) => {
            if (event.key === 'Tab') setOpen(false);
          }}
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
        </div>
        {label === undefined ? null : (
          <span id={labelId} hidden>
            {label}
          </span>
        )}
      </Popover>
    </MenuTrigger>
  );
}
