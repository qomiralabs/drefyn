'use client';
import type { ReactNode } from 'react';
import { Keyboard, MenuItem as AriaMenuItem, Text } from 'react-aria-components';

export interface MenuItemProps {
  id: string;
  children: ReactNode;
  onAction?: () => void;
  // Stays reachable by arrow keys and announces as unavailable.
  disabled?: boolean;
  shortcut?: string;
  icon?: ReactNode;
}

// Items sit flush in the panel, so the ring is drawn inside their edge. Focus and hover share
// the hover fill. A disabled item takes neither fill: it keeps its place and its ring so the
// keyboard can reach it and the reader learns it is unavailable.
const BASE =
  'flex min-h-row-compact items-center gap-8 rounded-sm px-8 text-body-s outline-none transition-colors duration-fast ease-enter data-focus-visible:focus-ring-inset';
const LIVE = 'cursor-default text-body data-focused:bg-hover data-pressed:bg-pressed';
const DISABLED = 'cursor-not-allowed text-disabled-text';

// The key is a shortcut, not part of the name, so screen readers get it from
// aria-keyshortcuts. React Aria filters that attribute out of an item's props, so it is
// written here.
const markShortcut = (shortcut: string | undefined) => (item: HTMLDivElement | null) => {
  if (item === null) return;
  if (shortcut === undefined) item.removeAttribute('aria-keyshortcuts');
  else item.setAttribute('aria-keyshortcuts', shortcut);
};

export function MenuItem({
  id,
  children,
  onAction,
  disabled = false,
  shortcut,
  icon,
}: MenuItemProps): ReactNode {
  return (
    <AriaMenuItem
      id={id}
      isDisabled={disabled}
      {...(onAction === undefined ? {} : { onAction })}
      ref={markShortcut(shortcut)}
      {...(typeof children === 'string' ? { textValue: children } : {})}
      className={`${BASE} ${disabled ? DISABLED : LIVE}`}
    >
      {icon === undefined ? null : (
        <span className={`inline-flex ${disabled ? 'text-disabled-text' : 'text-secondary'}`}>
          {icon}
        </span>
      )}
      <Text slot="label">{children}</Text>
      {shortcut === undefined ? null : (
        <Keyboard className="ms-auto ps-16 font-mono text-caption text-secondary">
          {shortcut}
        </Keyboard>
      )}
    </AriaMenuItem>
  );
}
