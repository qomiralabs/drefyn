'use client';
import { useId, useRef, useState, type ClipboardEvent, type ReactNode } from 'react';
import { markDisabled } from './field-parts.tsx';
import {
  focusLastChip,
  hiddenValues,
  holdBackspace,
  stepsOntoChip,
  TagBox,
  TagMessages,
} from './tag-box.tsx';

export interface TagFieldProps {
  // The visible label, which names the input.
  label: string;
  // Names the list of chips, such as Addresses to invite. Defaults to the label.
  tagsLabel?: string;
  value?: readonly string[];
  defaultValue?: readonly string[];
  onChange?: (value: string[]) => void;
  placeholder?: string;
  // Posts one value per chip.
  name?: string;
  description?: ReactNode;
  // A message for the whole field. Setting it marks the field invalid.
  error?: string;
  // A message for a chip, by its text. The chip shows the mark; the message shows under the field.
  tagErrors?: Readonly<Record<string, string>>;
  // Rendered as aria-disabled and read only, so the input stays focusable.
  disabled?: boolean;
  required?: boolean;
  inputMode?: 'text' | 'email';
}

const SPLIT = /[\s,;]+/;
const SEPARATOR = /[,;]/;

// Text that became several chips at once. A person types chips one at a time, but a paste or
// a phone keyboard can deliver a whole list in one change.
const partsOf = (text: string): string[] => text.split(SPLIT).filter((part) => part !== '');

// Free text that becomes chips: Enter, a comma, a paste or leaving the field adds what was
// typed, and a chip can carry its own error. For picks from a known list, use MultiCombobox.
// Validity stays with the form, which sets tagErrors after checking each chip.
export function TagField({
  label,
  tagsLabel,
  value,
  defaultValue,
  onChange,
  placeholder,
  name,
  description,
  error,
  tagErrors,
  disabled = false,
  required = false,
  inputMode = 'text',
}: TagFieldProps): ReactNode {
  if (label.trim() === '') throw new Error('TagField needs a visible label.');
  const id = useId();
  const [own, setOwn] = useState<readonly string[]>(defaultValue ?? []);
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const tags = value ?? own;
  const messages = [
    ...tags.flatMap((tag) => (tagErrors?.[tag] === undefined ? [] : [tagErrors[tag]])),
    ...(error === undefined || error.trim() === '' ? [] : [error]),
  ];
  const invalid = messages.length > 0;
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const describedBy = [description === undefined ? null : descriptionId, invalid ? errorId : null]
    .filter((part) => part !== null)
    .join(' ');

  const change = (next: string[]) => {
    if (value === undefined) setOwn(next);
    onChange?.(next);
  };
  const add = (raw: string) => {
    setText('');
    const fresh = [...new Set(partsOf(raw))].filter((part) => !tags.includes(part));
    if (fresh.length > 0) change([...tags, ...fresh]);
  };
  const paste = (event: ClipboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    const pasted = event.clipboardData.getData('text');
    // One tag stays in the input, to be edited before it is added.
    if (partsOf(pasted).length < 2) return;
    event.preventDefault();
    add(`${text} ${pasted}`);
  };

  return (
    <div className="flex flex-col gap-4">
      <label
        id={labelId}
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
      <TagBox
        labelId={labelId}
        tagsLabel={tagsLabel ?? label}
        tags={tags.map((tag) => ({
          id: tag,
          text: tag,
          bad: tagErrors?.[tag] !== undefined,
        }))}
        disabled={disabled}
        invalid={invalid}
        onRemove={(ids) => {
          change(tags.filter((tag) => !ids.includes(tag)));
        }}
        field={inputRef}
        boxRef={boxRef}
      >
        <input
          ref={(el) => {
            inputRef.current = el;
            markDisabled(disabled)(el);
          }}
          id={id}
          type="text"
          inputMode={inputMode}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={text}
          readOnly={disabled}
          aria-invalid={invalid ? true : undefined}
          aria-required={required && tags.length === 0 ? true : undefined}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          onChange={(event) => {
            const next = event.target.value;
            if (disabled) return;
            if (SEPARATOR.test(next)) add(next);
            else setText(next);
          }}
          onPaste={paste}
          onBlur={() => {
            if (!disabled && text !== '') add(text);
          }}
          onKeyDown={(event) => {
            if (disabled) {
              holdBackspace(event);
              return;
            }
            // Enter also ends a composition, and that text is not finished yet.
            if (event.nativeEvent.isComposing) return;
            if (stepsOntoChip(event, text, event.currentTarget.selectionStart)) {
              if (focusLastChip(boxRef.current)) event.preventDefault();
              return;
            }
            if (event.key === ',' || (event.key === 'Enter' && text !== '')) {
              event.preventDefault();
              add(text);
            }
          }}
          className={`h-control-sm min-w-0 flex-1 basis-128 bg-transparent text-body-s outline-none ${
            disabled
              ? 'cursor-not-allowed text-disabled-text placeholder:text-disabled-text'
              : 'text-ink placeholder:text-secondary'
          }`}
        />
      </TagBox>
      <TagMessages id={errorId} messages={messages} />
      {hiddenValues(name, tags)}
    </div>
  );
}
