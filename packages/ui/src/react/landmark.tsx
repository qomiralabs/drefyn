'use client';
import { useCallback, useRef, type RefObject } from 'react';
import { useLandmark as useAriaLandmark } from 'react-aria';

export type LandmarkRole =
  'banner' | 'navigation' | 'main' | 'complementary' | 'contentinfo' | 'search' | 'region';

export interface LandmarkOptions {
  role: LandmarkRole;
  // Required where two landmarks share a role, so a screen reader can tell them apart.
  label?: string;
  // Leaves the F6 cycle while true, for a sidebar that steps aside on phones. React Aria
  // only skips landmarks under aria-hidden, and a display none element cannot take focus,
  // so F6 would stop on it.
  skip?: boolean;
}

export interface LandmarkProps {
  tabIndex: -1;
  'aria-label'?: string;
}

// Puts a native landmark element in the page's one F6 cycle, the one ToastRegion is in.
// Two handlers would both move focus on one key press, and a page whose own regions are
// outside the cycle can reach the toasts but never leave them. Spread the props on the
// element: the role stays the element's own.
export function useLandmark(
  ref: RefObject<HTMLElement | null>,
  { role, label, skip = false }: LandmarkOptions,
): LandmarkProps {
  // React Aria registers only a ref that holds an element, so an empty one leaves the cycle.
  const none = useRef<HTMLElement>(null);
  // The landmark itself takes focus, as in React Aria's own regions, through the element
  // rather than React Aria's default, which sets state in this component to do it.
  const focus = useCallback(() => {
    ref.current?.focus();
  }, [ref]);
  useAriaLandmark(
    { role, focus, ...(label === undefined ? {} : { 'aria-label': label }) },
    skip ? none : ref,
  );
  return label === undefined ? { tabIndex: -1 } : { tabIndex: -1, 'aria-label': label };
}
