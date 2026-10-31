'use client';
import type { ReactNode } from 'react';
import { Tab as AriaTab } from 'react-aria-components';
import { markDisabled } from './field-parts.tsx';
import { useUnavailable } from './unavailable.ts';

export interface TabProps {
  value: string;
  children: string;
  // A count shown after the label in tabular figures, such as the pages behind the tab.
  count?: number;
  // Stays reachable by the arrow keys, announces as unavailable and is never shown.
  disabled?: boolean;
}

const counts = new Intl.NumberFormat('en');

const BASE =
  'relative inline-flex h-control-lg shrink-0 items-center gap-8 rounded-sm px-12 text-body-s whitespace-nowrap outline-none transition-colors duration-fast ease-enter data-focus-visible:focus-ring-inset';
const REST = 'cursor-pointer text-secondary hover:text-body';
const SELECTED = 'cursor-default font-medium text-ink';
const DISABLED = 'cursor-not-allowed text-disabled-text';

// The selected tab is ink in the medium weight with a 2 px accent indicator on the rule, and
// hover only darkens the label, so hover and selected never look alike. The label's medium
// weight copy sits hidden in the same grid cell, so selecting a tab never shifts the row.
export function Tab({ value, children, count, disabled = false }: TabProps): ReactNode {
  useUnavailable(value, disabled);
  return (
    <AriaTab
      id={value}
      ref={markDisabled(disabled)}
      className={({ isSelected }) =>
        `${BASE} ${disabled ? DISABLED : isSelected ? SELECTED : REST}`
      }
    >
      {({ isSelected }) => (
        <>
          <span className="inline-grid">
            <span aria-hidden="true" className="invisible col-start-1 row-start-1 font-medium">
              {children}
            </span>
            <span className="col-start-1 row-start-1">{children}</span>
          </span>
          {count === undefined ? null : (
            <span data-numeric="" className={disabled ? 'text-disabled-text' : 'text-secondary'}>
              {counts.format(count)}
            </span>
          )}
          {isSelected ? (
            <span
              aria-hidden="true"
              data-indicator=""
              className="absolute inset-x-0 bottom-0 border-b-indicator border-accent-ink"
            />
          ) : null}
        </>
      )}
    </AriaTab>
  );
}
