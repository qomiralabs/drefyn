'use client';
import { Children, useState, type ReactNode } from 'react';
import {
  Button,
  Label,
  ListBox,
  Popover,
  Select as AriaSelect,
  SelectValue,
  Text,
} from 'react-aria-components';
import { FieldMessage, markDisabled } from './field-parts.tsx';
import { chevronDownShape } from './icons/chevron-down.tsx';
import { Icon } from './icons/icon.tsx';
import { Skeleton } from './skeleton.tsx';

export interface SelectProps {
  // The visible label.
  label: string;
  // SelectOption elements.
  children: ReactNode;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  // Shown while nothing is chosen.
  placeholder?: string;
  name?: string;
  description?: ReactNode;
  // The message for an invalid choice. Setting it marks the select invalid.
  error?: string;
  // Rendered as aria-disabled so the trigger stays focusable and the reason can be read.
  disabled?: boolean;
  required?: boolean;
  // The options are still on their way: the list shows skeleton rows.
  loading?: boolean;
  size?: 'md' | 'lg';
  defaultOpen?: boolean;
}

// React Aria skips disabled options in arrow navigation unless the collection's disabled
// behaviour is 'selection'. Select does not type the prop but passes it to its list state,
// which honours it. Options still get aria-disabled and are never chosen.
const REACHABLE_WHEN_DISABLED = { disabledBehavior: 'selection' } as Record<string, unknown>;

const SIZE = { md: 'h-control-md px-8 text-body-s', lg: 'h-control-lg px-12 text-body-m' } as const;

// The trigger is drawn as a field, as the person fills it in. Hover changes nothing; the
// open trigger keeps its look, since the list beside it says it is open.
function triggerPaint(disabled: boolean, invalid: boolean): string {
  if (disabled)
    return 'border-disabled-edge bg-disabled-fill text-disabled-text cursor-not-allowed';
  return `${invalid ? 'border-state-broken-mark' : 'border-control'} bg-ground text-ink cursor-pointer`;
}

// The list announces what is happening while it waits, and draws three rows in their place.
function LoadingRows(): ReactNode {
  return (
    <span className="flex flex-col">
      <span className="sr-only">Loading options</span>
      {(['3/4', '1/2', '3/4'] as const).map((width, i) => (
        <span key={i} data-skeleton="" className="flex min-h-row-compact items-center px-8">
          <Skeleton width={width} />
        </span>
      ))}
    </span>
  );
}

const markBusy =
  (busy: boolean) =>
  (el: HTMLElement | null): void => {
    if (el === null) return;
    if (busy) el.setAttribute('aria-busy', 'true');
    else el.removeAttribute('aria-busy');
  };

// A React Aria select: a button that opens a listbox in a popover on the overlay surface,
// with a hidden native select so a form posts the value. It holds the value itself, so a
// disabled select can stay focusable and still refuse every change, typed letters included.
// Validity stays with the form: an error is joined to the trigger and never blocks a submit.
export function Select({
  label,
  children,
  value,
  defaultValue,
  onChange,
  placeholder = 'Choose one',
  name,
  description,
  error,
  disabled = false,
  required = false,
  loading = false,
  size = 'md',
  defaultOpen = false,
}: SelectProps): ReactNode {
  if (label.trim() === '') throw new Error('Select needs a visible label.');
  if (!loading && Children.count(children) === 0) {
    throw new Error(
      'A Select needs at least one option. Disable it with a reason instead of showing an empty list.',
    );
  }
  const [own, setOwn] = useState<string | null>(defaultValue ?? null);
  const [open, setOpen] = useState(defaultOpen && !disabled);
  const chosen = value ?? own;
  const invalid = error !== undefined && error.trim() !== '';
  return (
    <AriaSelect
      {...REACHABLE_WHEN_DISABLED}
      value={chosen}
      onChange={(next) => {
        if (disabled || next === null) return;
        const picked = String(next);
        if (value === undefined) setOwn(picked);
        onChange?.(picked);
      }}
      isOpen={open && !disabled}
      onOpenChange={(next) => {
        setOpen(next && !disabled);
      }}
      allowsEmptyCollection={loading}
      placeholder={placeholder}
      {...(name === undefined ? {} : { name })}
      isRequired={required}
      isInvalid={invalid}
      validationBehavior="aria"
      className="flex flex-col gap-4"
    >
      <Label className={`text-body-s font-medium ${disabled ? 'text-disabled-text' : 'text-body'}`}>
        {label}
      </Label>
      {description === undefined ? null : (
        <Text slot="description" className="max-w-measure text-caption text-secondary">
          {description}
        </Text>
      )}
      <Button
        ref={markDisabled(disabled)}
        className={`flex w-full min-w-0 items-center justify-between gap-8 rounded-sm border text-start transition-colors duration-fast ease-enter outline-none data-focus-visible:focus-ring ${SIZE[size]} ${triggerPaint(
          disabled,
          invalid,
        )}`}
      >
        <SelectValue className="truncate data-placeholder:text-secondary">
          {({ defaultChildren, isPlaceholder }) => (isPlaceholder ? placeholder : defaultChildren)}
        </SelectValue>
        <span className={`inline-flex ${disabled ? 'text-disabled-text' : 'text-secondary'}`}>
          <Icon name="chevron-down">{chevronDownShape}</Icon>
        </span>
      </Button>
      {invalid ? <FieldMessage>{error}</FieldMessage> : null}
      <Popover
        offset={4}
        data-select-popover=""
        className="z-overlay max-h-full min-w-128 overflow-auto rounded-md border border-rule-strong bg-overlay p-4 shadow-1 transition duration-base ease-enter data-entering:opacity-0 motion-safe:data-entering:-translate-y-4 motion-safe:data-[placement=top]:data-entering:translate-y-4"
      >
        <ListBox
          ref={markBusy(loading)}
          className="flex flex-col outline-none"
          {...(loading ? { renderEmptyState: () => <LoadingRows /> } : {})}
        >
          {loading ? [] : children}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}
