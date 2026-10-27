'use client';
import type { ReactNode } from 'react';
import { SwitchButton, SwitchField, Text } from 'react-aria-components';

export interface SwitchProps {
  // The visible label.
  children: ReactNode;
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  // Rendered as aria-disabled so the switch stays focusable and its reason can be read.
  disabled?: boolean;
  description?: ReactNode;
  name?: string;
  value?: string;
}

// React Aria disables the input natively, which drops it from the Tab order. A disabled
// switch is read only to React Aria instead, so it ignores clicks, label clicks and Space,
// and aria-disabled is written here because React Aria has no prop for it.
const markDisabled = (disabled: boolean) => (input: HTMLInputElement | null) => {
  if (input === null) return;
  if (disabled) input.setAttribute('aria-disabled', 'true');
  else input.removeAttribute('aria-disabled');
};

// The track is 32 by 20 with a 12 px thumb on a 24 px rail centred in it, so the thumb
// travels exactly one thumb width, a spacing token, with the same gap at both ends.
const TRACK = {
  live: 'border-control bg-control group-data-selected:border-accent-ink group-data-selected:bg-accent-ink',
  disabled: 'border-disabled-edge bg-disabled-fill',
} as const;

const THUMB = {
  live: 'bg-ground group-data-selected:bg-accent-on',
  disabled: 'bg-disabled-edge',
} as const;

// A React Aria switch on a real checkbox, so a form posts it without JS. Space flips it;
// Enter is left to the form, as on any checkbox. The label sits before the track and the
// description below, joined to the input by aria-describedby.
export function Switch({
  children,
  checked,
  defaultChecked,
  onChange,
  disabled = false,
  description,
  name,
  value,
}: SwitchProps): ReactNode {
  const look = disabled ? 'disabled' : 'live';
  return (
    <SwitchField
      className="flex flex-col gap-4"
      {...(checked === undefined ? {} : { isSelected: checked })}
      {...(defaultChecked === undefined ? {} : { defaultSelected: defaultChecked })}
      {...(onChange === undefined ? {} : { onChange })}
      {...(name === undefined ? {} : { name })}
      {...(value === undefined ? {} : { value })}
      isReadOnly={disabled}
      inputRef={markDisabled(disabled)}
    >
      <SwitchButton
        className={`group flex items-center justify-between gap-16 text-body-s [&_input]:outline-none ${
          disabled ? 'cursor-not-allowed text-disabled-text' : 'cursor-pointer text-body'
        }`}
      >
        <span>{children}</span>
        <span
          aria-hidden="true"
          className={`inline-flex h-icon-md w-32 shrink-0 items-center justify-center rounded-full border transition-colors duration-fast ease-enter group-data-focus-visible:focus-ring ${TRACK[look]}`}
        >
          <span className="flex w-24">
            <span
              className={`size-12 rounded-full transition-transform duration-move-fast ease-enter group-data-selected:translate-x-12 ${THUMB[look]}`}
            />
          </span>
        </span>
      </SwitchButton>
      {description === undefined ? null : (
        <Text slot="description" className="max-w-measure text-body-s text-secondary">
          {description}
        </Text>
      )}
    </SwitchField>
  );
}
