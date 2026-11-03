'use client';
import type { ReactNode } from 'react';
import { CheckboxButton, CheckboxField, Text } from 'react-aria-components';
import { checkShape } from './icons/check.tsx';
import { FieldMessage, markDisabled } from './field-parts.tsx';

export interface CheckboxProps {
  // The visible label.
  children: ReactNode;
  checked?: boolean;
  defaultChecked?: boolean;
  // Some of what the box stands for is checked, such as a select all box over a table.
  indeterminate?: boolean;
  onChange?: (checked: boolean) => void;
  // Rendered as aria-disabled so the box stays focusable and its reason can be read.
  disabled?: boolean;
  description?: ReactNode;
  // The message for an invalid value. Setting it marks the box invalid.
  error?: string;
  required?: boolean;
  name?: string;
  value?: string;
}

// The edge carries the box, since nothing else marks where it is. Checked and mixed fill
// with accent ink, which also takes the edge, so the box keeps its size.
function boxPaint(disabled: boolean, invalid: boolean): string {
  if (disabled) return 'border-disabled-edge bg-disabled-fill text-disabled-text';
  const edge = invalid ? 'border-state-broken-mark' : 'border-control';
  return `${edge} bg-ground text-accent-on group-data-selected:border-accent-ink group-data-selected:bg-accent-ink group-data-indeterminate:border-accent-ink group-data-indeterminate:bg-accent-ink`;
}

// A React Aria checkbox on a real input, so a form posts it without JS. Space toggles it;
// Enter is left to the form. Validity stays with the form: an error is shown and announced
// through aria-describedby, and never blocks a native submit.
export function Checkbox({
  children,
  checked,
  defaultChecked,
  indeterminate = false,
  onChange,
  disabled = false,
  description,
  error,
  required = false,
  name,
  value,
}: CheckboxProps): ReactNode {
  const invalid = error !== undefined && error.trim() !== '';
  return (
    <CheckboxField
      className="flex flex-col gap-4"
      {...(checked === undefined ? {} : { isSelected: checked })}
      {...(defaultChecked === undefined ? {} : { defaultSelected: defaultChecked })}
      {...(onChange === undefined ? {} : { onChange })}
      {...(name === undefined ? {} : { name })}
      {...(value === undefined ? {} : { value })}
      isIndeterminate={indeterminate}
      isRequired={required}
      isInvalid={invalid}
      validationBehavior="aria"
      isReadOnly={disabled}
      inputRef={markDisabled(disabled)}
    >
      {({ isSelected }) => (
        <>
          <CheckboxButton
            className={`group flex items-start gap-8 text-body-s [&_input]:outline-none ${
              disabled ? 'cursor-not-allowed text-disabled-text' : 'cursor-pointer text-body'
            }`}
          >
            {/* A zero width space gives the box a line box as tall as the label's first line,
                so the box centres on it at any type size. */}
            <span aria-hidden="true" className="flex shrink-0 items-center">
              {'\u200b'}
              <span
                data-box=""
                className={`inline-flex size-icon-sm items-center justify-center rounded-xs border transition-colors duration-fast ease-enter group-data-focus-visible:focus-ring ${boxPaint(
                  disabled,
                  invalid,
                )}`}
              >
                {indeterminate || isSelected ? (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="butt"
                    strokeLinejoin="miter"
                    focusable="false"
                    aria-hidden="true"
                    data-icon={indeterminate ? 'bar' : 'check'}
                    data-mark={indeterminate ? 'bar' : 'tick'}
                    className="size-12"
                  >
                    {indeterminate ? <path d="M6 12H18" /> : checkShape}
                  </svg>
                ) : null}
              </span>
            </span>
            <span>{children}</span>
          </CheckboxButton>
          {description === undefined ? null : (
            <Text slot="description" className="max-w-measure ps-24 text-caption text-secondary">
              {description}
            </Text>
          )}
          {invalid ? <FieldMessage className="ps-24">{error}</FieldMessage> : null}
        </>
      )}
    </CheckboxField>
  );
}
