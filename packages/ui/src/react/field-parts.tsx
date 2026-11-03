'use client';
import type { ReactNode } from 'react';
import { Text } from 'react-aria-components';
import { alertShape } from './icons/alert.tsx';
import { Icon } from './icons/icon.tsx';

// React Aria disables an input natively, which drops it from the Tab order. A disabled
// control is read only to React Aria instead, so it ignores every activation, and
// aria-disabled is written here because React Aria has no prop for it. A new callback each
// render makes React run it again, so the attribute follows the prop both ways.
export const markDisabled =
  (disabled: boolean) =>
  (el: HTMLElement | null): void => {
    if (el === null) return;
    if (disabled) el.setAttribute('aria-disabled', 'true');
    else el.removeAttribute('aria-disabled');
  };

// The message under an invalid control, in the slot React Aria joins to the control's
// aria-describedby. Not a live region: the form decides when to announce.
export function FieldMessage({
  children,
  className = '',
}: {
  children: string;
  className?: string;
}): ReactNode {
  return (
    <Text
      slot="errorMessage"
      className={`flex max-w-measure items-start gap-4 text-caption text-state-broken-text ${className}`}
    >
      <Icon name="alert" tone="broken">
        {alertShape}
      </Icon>
      <span>{children}</span>
    </Text>
  );
}
