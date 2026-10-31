'use client';
import { createContext, useState, type ReactNode } from 'react';
import { Label, RadioGroup as AriaRadioGroup, Text } from 'react-aria-components';
import { FieldMessage, markDisabled } from './field-parts.tsx';
import { UnavailableContext, useUnavailableSet } from './unavailable.ts';

export interface RadioGroupProps {
  // The visible group label.
  label: string;
  // Radio elements.
  children: ReactNode;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  name?: string;
  description?: ReactNode;
  // The message for an invalid choice. Setting it marks the group invalid.
  error?: string;
  // Rendered as aria-disabled so every radio stays focusable and the reason can be read.
  disabled?: boolean;
  required?: boolean;
  orientation?: 'vertical' | 'horizontal';
}

// What each Radio needs from its group to paint itself.
export const RadioLookContext = createContext<{ disabled: boolean; invalid: boolean }>({
  disabled: false,
  invalid: false,
});

// React Aria radios on native inputs, so a form posts the choice without JS. The group
// holds the value itself, so it can refuse a disabled radio that the arrow keys reached.
// Validity stays with the form: an error is shown and joined to the group, and never blocks
// a native submit.
export function RadioGroup({
  label,
  children,
  value,
  defaultValue,
  onChange,
  name,
  description,
  error,
  disabled = false,
  required = false,
  orientation = 'vertical',
}: RadioGroupProps): ReactNode {
  if (label.trim() === '') throw new Error('RadioGroup needs a visible label.');
  const unavailable = useUnavailableSet();
  const [own, setOwn] = useState<string | null>(defaultValue ?? null);
  const chosen = value ?? own;
  const invalid = error !== undefined && error.trim() !== '';
  const choose = (next: string | null) => {
    if (next === null || disabled || unavailable.current.has(next)) return;
    if (value === undefined) setOwn(next);
    onChange?.(next);
  };
  return (
    <AriaRadioGroup
      ref={markDisabled(disabled)}
      value={chosen}
      onChange={choose}
      {...(name === undefined ? {} : { name })}
      isRequired={required}
      isInvalid={invalid}
      validationBehavior="aria"
      orientation={orientation}
      className={`flex flex-col gap-8 ${disabled ? 'text-disabled-text' : 'text-body'}`}
    >
      <Label className={`text-body-s font-medium ${disabled ? 'text-disabled-text' : 'text-body'}`}>
        {label}
      </Label>
      {description === undefined ? null : (
        <Text slot="description" className="max-w-measure text-caption text-secondary">
          {description}
        </Text>
      )}
      <div
        className={
          orientation === 'horizontal' ? 'flex flex-wrap gap-x-24 gap-y-8' : 'flex flex-col gap-8'
        }
      >
        <UnavailableContext value={unavailable}>
          <RadioLookContext value={{ disabled, invalid }}>{children}</RadioLookContext>
        </UnavailableContext>
      </div>
      {invalid ? <FieldMessage>{error}</FieldMessage> : null}
    </AriaRadioGroup>
  );
}
