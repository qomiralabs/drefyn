'use client';
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  Tab as AriaTab,
  Tooltip as AriaTooltip,
  TooltipTriggerStateContext,
} from 'react-aria-components';
import { tokens } from '../tokens/tokens.ts';
import { useRegisterTab } from './tab-registry.ts';

interface TabBase {
  value: string;
  children: string;
  // A count shown after the label in tabular figures, such as the pages behind the tab.
  count?: number;
}

// A disabled tab stays reachable by the arrow keys and is never shown, so it must say why:
// the reason is joined to the tab and shown in a tooltip on hover and focus.
export type TabProps = TabBase &
  ({ disabled?: false; reason?: never } | { disabled: true; reason: string });

const counts = new Intl.NumberFormat('en');

const BASE =
  'relative inline-flex h-control-lg shrink-0 items-center gap-8 rounded-sm px-12 text-body-s whitespace-nowrap outline-none transition-colors duration-fast ease-enter data-focus-visible:focus-ring-inset';
const REST = 'cursor-pointer text-secondary hover:text-body';
const SELECTED = 'cursor-default font-medium text-ink';
const DISABLED = 'cursor-not-allowed text-disabled-text';

// React Aria filters aria-disabled and aria-describedby out of a tab's props, so both are
// written on the element. A new callback each render keeps them in step with the props.
const mark =
  (target: RefObject<HTMLElement | null>, disabled: boolean, describedBy: string | null) =>
  (el: HTMLElement | null): void => {
    target.current = el;
    if (el === null) return;
    if (disabled) el.setAttribute('aria-disabled', 'true');
    else el.removeAttribute('aria-disabled');
    if (describedBy === null) el.removeAttribute('aria-describedby');
    else el.setAttribute('aria-describedby', describedBy);
  };

// The reason in a tooltip by the tab: at once on keyboard focus, after the tooltip wait on
// hover. Escape hides it without moving focus, until the tab is left and reached again.
function ReasonTip({
  tab,
  reason,
  focused,
  hovered,
}: {
  tab: RefObject<HTMLElement | null>;
  reason: string;
  focused: boolean;
  hovered: boolean;
}): ReactNode {
  const [waited, setWaited] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const active = focused || hovered;
  if (!active && (waited || dismissed)) {
    setWaited(false);
    setDismissed(false);
  }
  useEffect(() => {
    if (!hovered) return;
    const timer = window.setTimeout(() => {
      setWaited(true);
    }, tokens.timer.tooltip.ms);
    return () => {
      window.clearTimeout(timer);
    };
  }, [hovered]);
  const open = !dismissed && (focused || (hovered && waited));
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDismissed(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);
  // React Aria's tooltip reads its open state from a trigger's context even when it is
  // placed by triggerRef, so the tab provides one. Closing through it, as React Aria does on
  // scroll, counts as a dismissal.
  const state = {
    isOpen: open,
    shouldSkipAnimation: true,
    open: () => undefined,
    close: () => {
      setDismissed(true);
    },
  };
  return (
    <TooltipTriggerStateContext value={state}>
      <AriaTooltip
        triggerRef={tab}
        isOpen={open}
        placement="bottom"
        offset={tokens.space[4]}
        className="z-overlay max-w-measure rounded-sm border border-rule-strong bg-overlay px-8 py-4 text-caption text-body shadow-1"
      >
        {reason}
      </AriaTooltip>
    </TooltipTriggerStateContext>
  );
}

// The selected tab is ink in the medium weight with a 2 px accent indicator on the rule, and
// hover only darkens the label, so hover and selected never look alike. The label's medium
// weight copy sits hidden in the same grid cell, so selecting a tab never shifts the row.
export function Tab({ value, children, count, disabled = false, reason }: TabProps): ReactNode {
  if (disabled && (reason === undefined || reason.trim() === '')) {
    throw new Error('A disabled Tab needs a reason to say why it cannot be shown.');
  }
  useRegisterTab(value, disabled);
  const reasonId = useId();
  const tab = useRef<HTMLElement>(null);
  const why = disabled ? reason : undefined;
  return (
    <AriaTab
      id={value}
      ref={mark(tab, disabled, why === undefined ? null : reasonId)}
      className={({ isSelected }) =>
        `${BASE} ${disabled ? DISABLED : isSelected ? SELECTED : REST}`
      }
    >
      {({ isSelected, isHovered, isFocusVisible }) => (
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
          {why === undefined ? null : (
            <>
              <span id={reasonId} hidden>
                {why}
              </span>
              <ReasonTip tab={tab} reason={why} focused={isFocusVisible} hovered={isHovered} />
            </>
          )}
        </>
      )}
    </AriaTab>
  );
}
