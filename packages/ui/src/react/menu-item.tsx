'use client';
import type { ReactNode } from 'react';
import { Keyboard, MenuItem as AriaMenuItem, Text } from 'react-aria-components';
import { ROW } from './sheet.tsx';

export interface MenuItemProps {
  id: string;
  children: ReactNode;
  onAction?: () => void;
  // Stays reachable by arrow keys and announces as unavailable.
  disabled?: boolean;
  // Why the item is unavailable, shown under it and read as its description.
  reason?: string;
  shortcut?: string;
  icon?: ReactNode;
}

// Items sit flush in the panel, so the ring is drawn inside their edge. Focus and hover share
// the hover fill. A disabled item takes neither fill: it keeps its place and its ring so the
// keyboard can reach it and the reader learns it is unavailable.
const BASE =
  'flex items-center gap-8 rounded-sm px-8 text-body-s outline-none transition-colors duration-fast ease-enter data-focus-visible:focus-ring-inset';
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
  reason,
  shortcut,
  icon,
}: MenuItemProps): ReactNode {
  const why = disabled && reason !== undefined && reason.trim() !== '' ? reason : undefined;
  return (
    <AriaMenuItem
      id={id}
      isDisabled={disabled}
      {...(onAction === undefined ? {} : { onAction })}
      ref={markShortcut(shortcut)}
      {...(typeof children === 'string' ? { textValue: children } : {})}
      className={`${BASE} ${why === undefined ? ROW : `${ROW} py-4`} ${disabled ? DISABLED : LIVE}`}
    >
      {icon === undefined ? null : (
        <span className={`inline-flex ${disabled ? 'text-disabled-text' : 'text-secondary'}`}>
          {icon}
        </span>
      )}
      {why === undefined ? (
        <Text slot="label" className={shortcut === undefined ? undefined : 'flex-1 pe-16'}>
          {children}
        </Text>
      ) : (
        <span className="flex min-w-0 flex-1 flex-col pe-16">
          <Text slot="label">{children}</Text>
          {/* The reason is what a person needs to read, so it keeps the secondary colour;
              only the label takes the disabled one. */}
          <Text slot="description" className="text-caption text-secondary">
            {why}
          </Text>
        </span>
      )}
      {shortcut === undefined ? null : (
        // A hairline keycap on paper, as in the spike: decoration only, the key is announced
        // through aria-keyshortcuts.
        <Keyboard className="inline-flex items-center justify-center rounded-sm border border-rule-strong bg-ground px-4 text-label text-secondary">
          {shortcut}
        </Keyboard>
      )}
    </AriaMenuItem>
  );
}
