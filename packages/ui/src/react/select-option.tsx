'use client';
import type { ReactNode } from 'react';
import { ListBoxItem, Text } from 'react-aria-components';
import { markDisabled } from './field-parts.tsx';
import { checkShape } from './icons/check.tsx';
import { Icon } from './icons/icon.tsx';

export interface SelectOptionProps {
  value: string;
  // Text only, so typing a letter can find the option.
  children: string;
  description?: string;
  // Stays reachable by the arrow keys, announces as unavailable and is never chosen.
  disabled?: boolean;
}

// Options sit flush in the panel, so the ring is drawn inside their edge, as menu items do.
// The chosen one shows a tick in accent ink and no wash: the tick and aria-selected carry it.
const BASE =
  'flex min-h-row-compact items-center gap-8 rounded-sm px-8 py-4 text-body-s outline-none transition-colors duration-fast ease-enter data-focus-visible:focus-ring-inset';
const LIVE = 'cursor-default text-body data-focused:bg-hover data-pressed:bg-pressed';
const DISABLED = 'cursor-not-allowed text-disabled-text';

export function SelectOption({
  value,
  children,
  description,
  disabled = false,
}: SelectOptionProps): ReactNode {
  return (
    <ListBoxItem
      id={value}
      textValue={children}
      isDisabled={disabled}
      // A disabled option stays reachable, so React Aria leaves aria-disabled off it.
      ref={markDisabled(disabled)}
      className={`${BASE} ${disabled ? DISABLED : LIVE}`}
    >
      {({ isSelected }) => (
        <>
          <span className="flex min-w-0 flex-1 flex-col">
            <Text slot="label">{children}</Text>
            {description === undefined ? null : (
              <Text
                slot="description"
                className={`text-caption ${disabled ? 'text-disabled-text' : 'text-secondary'}`}
              >
                {description}
              </Text>
            )}
          </span>
          {isSelected ? (
            <span className="inline-flex text-accent-ink">
              <Icon name="check">{checkShape}</Icon>
            </span>
          ) : null}
        </>
      )}
    </ListBoxItem>
  );
}
