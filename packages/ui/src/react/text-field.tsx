import type { ChangeEvent, ComponentPropsWithRef, ReactNode } from 'react';
import { alertShape } from './icons/alert.tsx';
import { Icon } from './icons/icon.tsx';

export interface TextFieldProps extends Omit<
  ComponentPropsWithRef<'input'>,
  'className' | 'style' | 'size' | 'disabled' | 'onChange' | 'type' | 'id' | 'children'
> {
  // Required, so the label, description and error can be wired without a hook.
  id: string;
  label: string;
  description?: ReactNode;
  // The message for an invalid value. Setting it marks the field invalid.
  error?: string;
  type?: 'text' | 'email' | 'url' | 'password' | 'search' | 'tel';
  size?: 'md' | 'lg';
  // Rendered as aria-disabled and read only, so the field stays focusable.
  disabled?: boolean;
  onChange?: (value: string) => void;
}

const SIZE = { md: 'h-control-md px-8 text-body-s', lg: 'h-control-lg px-12 text-body-m' } as const;

const BASE =
  'w-full min-w-0 rounded-sm border placeholder:text-secondary transition-colors duration-fast ease-enter focus-visible:focus-ring';

// Hover changes nothing, so a field never looks pressed. A read only value drops its edge and
// sits on raised; disabled takes the disabled family and no placeholder change.
function paint(disabled: boolean, readOnly: boolean, invalid: boolean): string {
  if (disabled)
    return 'border-disabled-edge bg-disabled-fill text-disabled-text cursor-not-allowed';
  if (readOnly) return 'border-transparent bg-raised text-ink';
  if (invalid) return 'border-state-broken-mark bg-ground text-ink';
  return 'border-control bg-ground text-ink';
}

// A native input, so it renders on the server and posts with no script. Validation belongs to
// the form: pass the message on blur or after a submit, and move focus to the first invalid
// field. The field itself is never a live region.
export function TextField({
  id,
  label,
  description,
  error,
  type = 'text',
  size = 'md',
  disabled = false,
  readOnly = false,
  onChange,
  ...props
}: TextFieldProps): ReactNode {
  if (label.trim() === '') throw new Error('TextField needs a visible label.');
  if (id.trim() === '') throw new Error('TextField needs an id to wire its label.');
  // The types refuse both; a caller without types still never ships them.
  const rest: typeof props & { style?: undefined; className?: undefined } = { ...props };
  delete rest.style;
  delete rest.className;
  const invalid = error !== undefined && error.trim() !== '';
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  // A caller's own description comes first, then the field's description and error.
  const describedBy = [
    rest['aria-describedby'] ?? null,
    description === undefined ? null : descriptionId,
    invalid ? errorId : null,
  ]
    .filter((part) => part !== null && part !== '')
    .join(' ');
  // Disabled is read only too, so it keeps focus and its value but never changes.
  const handle =
    onChange === undefined || disabled
      ? undefined
      : (event: ChangeEvent<HTMLInputElement>) => {
          onChange(event.target.value);
        };
  return (
    <div className="flex flex-col gap-4">
      <label
        htmlFor={id}
        className={`text-body-s font-medium ${disabled ? 'text-disabled-text' : 'text-body'}`}
      >
        {label}
      </label>
      {description === undefined ? null : (
        <span id={descriptionId} className="max-w-measure text-caption text-secondary">
          {description}
        </span>
      )}
      <input
        {...rest}
        id={id}
        type={type}
        readOnly={disabled || readOnly}
        aria-disabled={disabled ? true : undefined}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        onChange={handle}
        className={`${BASE} ${SIZE[size]} ${paint(disabled, readOnly, invalid)}`}
      />
      {invalid ? (
        <span
          id={errorId}
          className="flex max-w-measure items-start gap-4 text-caption text-state-broken-text"
        >
          <Icon name="alert" tone="broken">
            {alertShape}
          </Icon>
          <span>{error}</span>
        </span>
      ) : null}
    </div>
  );
}
