'use client';
import {
  Children,
  Fragment,
  isValidElement,
  useContext,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  Autocomplete,
  Button,
  ComboBox,
  ComboBoxStateContext,
  Group,
  Input,
  ListBox,
  Popover,
  TextField,
  useFilter,
  type Selection,
} from 'react-aria-components';
import { markDisabled } from './field-parts.tsx';
import { LoadingRows, markBusy } from './list-parts.tsx';
import { ROW, Sheet, usePhone } from './sheet.tsx';
import type { SelectOptionProps } from './select-option.tsx';
import { focusLastChip, hiddenValues, stepsOntoChip, TagBox, TagMessages } from './tag-box.tsx';

export interface MultiComboboxProps {
  // The visible label, and the title of the sheet on a phone.
  label: string;
  // Names the list of chips, such as Projects this key can reach. Defaults to the label.
  tagsLabel?: string;
  // SelectOption elements, directly or in an array. The list can be empty.
  children: ReactNode;
  value?: readonly string[];
  defaultValue?: readonly string[];
  onChange?: (value: string[]) => void;
  // Shown in the empty input, and on the search in the sheet.
  placeholder?: string;
  // Posts one value per chip.
  name?: string;
  description?: ReactNode;
  // The message for an invalid choice. Setting it marks the field invalid.
  error?: string;
  // Rendered as aria-disabled and read only, so the input stays focusable.
  disabled?: boolean;
  required?: boolean;
  // The options are still on their way: the list shows skeleton rows.
  loading?: boolean;
  // Shown when the list has nothing to show.
  emptyText?: string;
  // The line under a search, such as 2 of 4 projects match docs.
  countLabel?: (matches: number, total: number, query: string) => string;
  defaultOpen?: boolean;
  defaultSearch?: string;
}

interface Option {
  value: string;
  text: string;
}

// The options as data, because the chips outlive the list: a filtered or closed list has no
// collection to read a chip's text from.
function optionsIn(children: ReactNode): Option[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement(child)) return [];
    if (child.type === Fragment) {
      return optionsIn((child as ReactElement<{ children: ReactNode }>).props.children);
    }
    const { value, children: text } = child.props as Partial<SelectOptionProps>;
    return value === undefined || text === undefined ? [] : [{ value, text }];
  });
}

const sameKeys = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((key, i) => key === b[i]);

// React Aria's combobox skips disabled options, and a disabled option has to stay reachable
// so its reason can be read. The keys are the options on show.
// Neither prop is typed on ComboBox, which passes both to its list state and its hook.
const walkShown = (keys: readonly string[]): Record<string, unknown> => ({
  disabledBehavior: 'selection',
  keyboardDelegate: {
    getKeyBelow: (key: string | number) => keys[keys.indexOf(String(key)) + 1] ?? null,
    getKeyAbove: (key: string | number) => keys[keys.indexOf(String(key)) - 1] ?? null,
    getFirstKey: () => keys[0] ?? null,
    getLastKey: () => keys.at(-1) ?? null,
  },
});

const INPUT = 'h-control-sm w-full bg-transparent text-body-s outline-none';

const emptyRow = (text: string): ReactNode => (
  <span className={`flex items-center px-8 text-body-s text-secondary ${ROW}`}>{text}</span>
);

function CountLine({ children }: { children: string }): ReactNode {
  return (
    <p className="mt-4 border-t border-rule px-8 pt-8 pb-4 text-caption text-secondary tabular-nums">
      {children}
    </p>
  );
}

// The input, with the keys React Aria leaves wrong for a list that takes several picks.
function SearchInput({
  placeholder,
  disabled,
  invalid,
  defaultOpen,
  query,
  inputRef,
  boxRef,
}: {
  placeholder: string;
  disabled: boolean;
  invalid: boolean;
  defaultOpen: boolean;
  query: string;
  inputRef: RefObject<HTMLInputElement | null>;
  boxRef: RefObject<HTMLDivElement | null>;
}): ReactNode {
  const state = useContext(ComboBoxStateContext);
  const startOpen = useEffectEvent(() => {
    if (!defaultOpen || disabled || state === null) return;
    inputRef.current?.focus();
    state.open(null, 'input');
  });
  useEffect(() => {
    startOpen();
  }, []);

  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (disabled || state === null) return;
    if (state.isOpen && event.key === 'Escape') {
      // With a pick made React Aria lets Escape carry on, and a dialog around this would
      // close with the list.
      event.stopPropagation();
      event.preventDefault();
      state.revert();
      return;
    }
    if (state.isOpen && event.key === 'Tab') {
      // Tab commits the active option, which here would take off a pick on the way past.
      state.selectionManager.setFocusedKey(null);
      return;
    }
    if (
      stepsOntoChip(event, query, event.currentTarget.selectionStart) &&
      focusLastChip(boxRef.current)
    ) {
      event.stopPropagation();
      event.preventDefault();
    }
  };

  return (
    <Input
      ref={(el) => {
        inputRef.current = el;
        markDisabled(disabled)(el);
      }}
      placeholder={placeholder}
      aria-invalid={invalid ? true : undefined}
      onKeyDownCapture={keys}
      onClick={() => {
        if (!disabled && state?.isOpen === false) state.open(null, 'manual');
      }}
      className={`${INPUT} ${
        disabled
          ? 'cursor-not-allowed text-disabled-text placeholder:text-disabled-text'
          : 'text-ink placeholder:text-secondary'
      }`}
    />
  );
}

// Several picks from a known list: a search with chips before it, built on React Aria's
// combobox, whose popover floats by the box. On a phone the box shows a button instead, and
// the search and list open in the bottom sheet, since a keyboard and a floating list do not
// fit on one small screen. Picks stay until removed, by the chip's button, by Backspace on
// the chip, or by picking the option again. Validity stays with the form.
export function MultiCombobox({
  label,
  tagsLabel,
  children,
  value,
  defaultValue,
  onChange,
  placeholder = 'Search',
  name,
  description,
  error,
  disabled = false,
  required = false,
  loading = false,
  emptyText = 'No matches',
  countLabel,
  defaultOpen = false,
  defaultSearch = '',
}: MultiComboboxProps): ReactNode {
  if (label.trim() === '') throw new Error('MultiCombobox needs a visible label.');
  const id = useId();
  const [own, setOwn] = useState<readonly string[]>(defaultValue ?? []);
  const [query, setQuery] = useState(defaultSearch);
  const [sheetOpen, setSheetOpen] = useState(defaultOpen && !disabled);
  const [listOpen, setListOpen] = useState(false);
  const phone = usePhone();
  const { contains } = useFilter({ sensitivity: 'base' });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = phone ? buttonRef : inputRef;

  const chosen = value ?? own;
  const keys = useMemo(() => [...chosen], [chosen]);
  const options = optionsIn(children);
  const shown = options.filter((option) => contains(option.text, query));
  const invalid = error !== undefined && error.trim() !== '';
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const describedBy = [description === undefined ? null : descriptionId, invalid ? errorId : null]
    .filter((part) => part !== null)
    .join(' ');
  const descriptionProps = describedBy === '' ? {} : { 'aria-describedby': describedBy };
  const count =
    countLabel === undefined || query === '' || loading
      ? null
      : countLabel(shown.length, options.length, query);

  // React Aria reports the same picks again whenever the list closes.
  const change = (next: string[]) => {
    if (disabled || sameKeys(next, chosen)) return;
    if (value === undefined) setOwn(next);
    onChange?.(next);
  };
  const pick = (keys: Selection) => {
    if (keys !== 'all') change([...keys].map(String));
  };
  const renderEmptyState = () => (loading ? <LoadingRows /> : emptyRow(emptyText));
  const list = (selection: object) => (
    <ListBox
      {...selection}
      ref={markBusy(loading)}
      renderEmptyState={renderEmptyState}
      className="flex min-h-0 flex-col overflow-y-auto outline-none"
    >
      {loading ? [] : children}
    </ListBox>
  );

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
        tags={chosen.map((key) => {
          const option = options.find((candidate) => candidate.value === key);
          return { id: key, text: option?.text ?? key, waiting: option === undefined && loading };
        })}
        disabled={disabled}
        invalid={invalid}
        listOpen={listOpen}
        onRemove={(ids) => {
          change(chosen.filter((key) => !ids.includes(key)));
        }}
        field={fieldRef}
        boxRef={boxRef}
      >
        {phone ? (
          <>
            <Button
              id={id}
              ref={(el) => {
                buttonRef.current = el;
                markDisabled(disabled)(el);
              }}
              aria-haspopup="dialog"
              aria-expanded={sheetOpen}
              aria-labelledby={`${labelId} ${id}`}
              {...descriptionProps}
              onPress={() => {
                if (!disabled) setSheetOpen(true);
              }}
              className={`h-control-sm min-w-0 flex-1 basis-128 truncate text-start text-body-s outline-none data-focus-visible:focus-ring ${
                disabled ? 'cursor-not-allowed text-disabled-text' : 'cursor-pointer text-secondary'
              }`}
            >
              {placeholder}
            </Button>
            <Sheet
              title={label}
              open={sheetOpen}
              onOpenChange={(next) => {
                setSheetOpen(next);
                if (!next) setQuery('');
              }}
              trigger={buttonRef}
            >
              <Autocomplete inputValue={query} onInputChange={setQuery} filter={contains}>
                <TextField
                  aria-label={placeholder}
                  autoFocus
                  className="sticky top-0 z-raised mb-4 flex bg-overlay p-4"
                >
                  <Input
                    placeholder={placeholder}
                    className={`${INPUT} rounded-sm border border-control bg-ground px-8 text-ink placeholder:text-secondary focus-visible:focus-ring`}
                  />
                </TextField>
                {list({
                  selectionMode: 'multiple',
                  selectedKeys: chosen,
                  onSelectionChange: pick,
                  disabledBehavior: 'selection',
                  // By default Escape clears a list's selection, which here is every pick.
                  escapeKeyBehavior: 'none',
                })}
              </Autocomplete>
              {count === null ? null : <CountLine>{count}</CountLine>}
            </Sheet>
          </>
        ) : (
          <ComboBox
            id={id}
            aria-labelledby={labelId}
            {...descriptionProps}
            selectionMode="multiple"
            // Both value and text are held here, so a pick keeps the search for the next one.
            value={keys}
            onChange={(next) => {
              change(next.map(String));
            }}
            inputValue={query}
            onInputChange={setQuery}
            onOpenChange={(open) => {
              setListOpen(open);
              if (!open) setQuery('');
            }}
            allowsEmptyCollection
            {...walkShown(shown.map((option) => option.value))}
            isReadOnly={disabled}
            isRequired={required}
            isInvalid={invalid}
            validationBehavior="aria"
            className="min-w-0 flex-1 basis-128"
          >
            {/* With no group React Aria sizes the list to the input; this hands that to boxRef. */}
            <Group role="presentation">
              <SearchInput
                placeholder={placeholder}
                disabled={disabled}
                invalid={invalid}
                defaultOpen={defaultOpen}
                query={query}
                inputRef={inputRef}
                boxRef={boxRef}
              />
            </Group>
            <Popover
              triggerRef={boxRef}
              offset={4}
              data-select-popover=""
              className="z-overlay flex max-h-full min-w-128 flex-col rounded-md border border-rule-strong bg-overlay p-4 shadow-1 transition duration-base ease-enter data-entering:opacity-0 motion-safe:data-entering:-translate-y-4 motion-safe:data-[placement=top]:data-entering:translate-y-4"
            >
              {list({})}
              {count === null ? null : <CountLine>{count}</CountLine>}
            </Popover>
          </ComboBox>
        )}
      </TagBox>
      <TagMessages id={errorId} messages={invalid ? [error] : []} />
      {hiddenValues(name, chosen)}
    </div>
  );
}
