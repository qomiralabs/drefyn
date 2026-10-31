'use client';
import { useContext, type ReactNode } from 'react';
import { RadioButton, RadioField, Text } from 'react-aria-components';
import { markDisabled } from './field-parts.tsx';
import { RadioLookContext } from './radio-group.tsx';
import { useUnavailable } from './unavailable.ts';

export interface RadioProps {
  value: string;
  // The visible label.
  children: ReactNode;
  description?: ReactNode;
  // Stays reachable by the arrow keys, announces as unavailable and is never chosen.
  disabled?: boolean;
}

function circlePaint(disabled: boolean, invalid: boolean): string {
  if (disabled) return 'border-disabled-edge bg-disabled-fill';
  const edge = invalid ? 'border-state-broken-mark' : 'border-control';
  return `${edge} bg-ground group-data-selected:border-accent-ink`;
}

// A circle on the control edge; the chosen one takes the accent edge and an accent dot.
export function Radio({ value, children, description, disabled = false }: RadioProps): ReactNode {
  const group = useContext(RadioLookContext);
  const off = disabled || group.disabled;
  useUnavailable(value, disabled);
  return (
    <RadioField value={value} inputRef={markDisabled(off)} className="flex flex-col gap-4">
      <RadioButton
        className={`group flex items-start gap-8 text-body-s [&_input]:outline-none ${
          off ? 'cursor-not-allowed text-disabled-text' : 'cursor-pointer text-body'
        }`}
      >
        {/* A zero width space gives the circle a line box as tall as the label's first line,
            so the circle centres on it at any type size. */}
        <span aria-hidden="true" className="flex shrink-0 items-center">
          {'​'}
          <span
            data-box=""
            className={`inline-flex size-icon-sm items-center justify-center rounded-full border transition-colors duration-fast ease-enter group-data-focus-visible:focus-ring ${circlePaint(
              off,
              group.invalid,
            )}`}
          >
            <span
              className={`size-8 rounded-full ${
                off ? 'group-data-selected:bg-disabled-edge' : 'group-data-selected:bg-accent-ink'
              }`}
            />
          </span>
        </span>
        <span>{children}</span>
      </RadioButton>
      {description === undefined ? null : (
        <Text slot="description" className="max-w-measure ps-24 text-caption text-secondary">
          {description}
        </Text>
      )}
    </RadioField>
  );
}
