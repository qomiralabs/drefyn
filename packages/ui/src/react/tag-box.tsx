'use client';
import { useEffect, useRef, type ReactNode, type Ref, type RefObject } from 'react';
import { Button, Tag, TagGroup, TagList } from 'react-aria-components';
import { markDisabled } from './field-parts.tsx';
import { alertShape } from './icons/alert.tsx';
import { IconCross } from './icons/cross.tsx';
import { Icon } from './icons/icon.tsx';
import { Skeleton } from './skeleton.tsx';

export interface TagItem {
  id: string;
  text: string;
  bad?: boolean;
  // The text is on its way, so the chip holds its place.
  waiting?: boolean;
}

export interface TagBoxProps {
  labelId: string;
  // Names the list of chips, apart from the input beside them.
  tagsLabel: string;
  tags: readonly TagItem[];
  disabled: boolean;
  invalid: boolean;
  // A combobox list is open beside the chips.
  listOpen?: boolean;
  onRemove: (ids: string[]) => void;
  // Where focus goes when the chip that held it is gone.
  field: RefObject<HTMLElement | null>;
  boxRef?: Ref<HTMLDivElement>;
  // The input, after the chips and on the same lines.
  children: ReactNode;
}

function chipPaint(disabled: boolean, bad: boolean): string {
  if (disabled) return 'border-disabled-edge bg-disabled-fill text-disabled-text';
  return `${bad ? 'border-state-broken-mark' : 'border-rule-strong'} bg-raised text-ink`;
}

function boxPaint(disabled: boolean, invalid: boolean): string {
  if (disabled) return 'border-disabled-edge bg-disabled-fill';
  return `${invalid ? 'border-state-broken-mark' : 'border-control'} bg-ground`;
}

const chipName = (tag: TagItem): string => {
  if (tag.waiting === true) return 'Loading';
  return tag.bad === true ? `${tag.text}, has an error` : tag.text;
};

// Backspace or the left arrow at the start of an empty input steps onto the last chip. A
// held key stops here, so clearing the text never runs on into removing chips.
export function stepsOntoChip(
  event: { key: string; repeat: boolean },
  text: string,
  caret: number | null,
): boolean {
  if (event.repeat || text !== '' || caret !== 0) return false;
  return event.key === 'Backspace' || event.key === 'ArrowLeft';
}

// WebKit can take Backspace in a read only input as going back a page.
export function holdBackspace(event: { key: string; preventDefault: () => void }): void {
  if (event.key === 'Backspace') event.preventDefault();
}

export function focusLastChip(box: HTMLElement | null): boolean {
  const last = box?.querySelectorAll<HTMLElement>('[role="row"]');
  const row = last?.[last.length - 1];
  row?.focus();
  return row !== undefined;
}

// The box drawn as one field: chips first, then the input, wrapping together, with the ring
// on the box while the input has focus. React Aria's tag group runs the keys on the chips:
// the arrows between them, Delete or Backspace on one, Tab on to its button.
export function TagBox({
  labelId,
  tagsLabel,
  tags,
  disabled,
  invalid,
  listOpen = false,
  onRemove,
  field,
  boxRef,
  children,
}: TagBoxProps): ReactNode {
  // React Aria walks focus to the next chip after a removal, which suits the keyboard on a
  // chip. A press on a button goes to the input first, so that walk never starts; removing
  // the only chip has nowhere to walk to.
  const removed = useRef(false);
  useEffect(() => {
    if (removed.current && tags.length === 0) field.current?.focus();
    removed.current = false;
  }, [tags.length, field]);
  const remove = (keys: Set<string | number>) => {
    removed.current = true;
    if (document.activeElement?.getAttribute('role') !== 'row') field.current?.focus();
    onRemove([...keys].map(String));
  };
  return (
    <div
      ref={boxRef}
      role="group"
      aria-labelledby={labelId}
      className={`flex min-h-control-lg flex-wrap items-center gap-4 rounded-sm border px-8 py-4 transition-colors duration-fast ease-enter has-[input:focus-visible]:focus-ring ${boxPaint(
        disabled,
        invalid,
      )}`}
    >
      {tags.length === 0 ? null : (
        // An open combobox hides the rest of the page from readers, which would leave the
        // chips hidden yet reachable by Tab. The marker exempts them, so it is set only for
        // that: a modal over the page has to hide them too.
        <div {...(listOpen ? { 'data-react-aria-top-layer': '' } : {})} className="contents">
          <TagGroup
            aria-label={tagsLabel}
            className="contents"
            {...(disabled ? {} : { onRemove: remove })}
          >
            <TagList className="contents">
              {tags.map((tag) => (
                <Tag
                  key={tag.id}
                  id={tag.id}
                  textValue={chipName(tag)}
                  // React Aria's own disabled chip leaves the keyboard, and it has to stay
                  // reachable so the value can be read.
                  ref={markDisabled(disabled)}
                  className={`inline-flex max-w-full min-w-0 items-center gap-4 rounded-xs border ps-8 text-body-s outline-none data-focus-visible:focus-ring ${tag.bad === true ? 'ps-4' : ''} ${chipPaint(disabled, tag.bad === true)}`}
                >
                  {tag.bad === true ? (
                    <Icon name="alert" tone="broken">
                      {alertShape}
                    </Icon>
                  ) : null}
                  {tag.waiting === true ? (
                    <span data-skeleton="" className="w-64">
                      <Skeleton width="3/4" />
                    </span>
                  ) : (
                    <span className="truncate">{tag.text}</span>
                  )}
                  {disabled ? (
                    <span className="h-control-sm" />
                  ) : (
                    <Button
                      slot="remove"
                      className="inline-flex size-control-sm shrink-0 cursor-pointer items-center justify-center text-secondary transition-colors duration-fast ease-enter outline-none data-focus-visible:focus-ring-inset data-hovered:bg-hover data-hovered:text-ink"
                    >
                      <IconCross />
                    </Button>
                  )}
                </Tag>
              ))}
            </TagList>
          </TagGroup>
        </div>
      )}
      {children}
    </div>
  );
}

// Every problem under the field, joined to the input by the id. Not a live region: the form
// decides when to announce.
export function TagMessages({
  id,
  messages,
}: {
  id: string;
  messages: readonly string[];
}): ReactNode {
  if (messages.length === 0) return null;
  return (
    <ul id={id} className="flex flex-col gap-2">
      {messages.map((message, i) => (
        <li
          key={i}
          className="flex max-w-measure items-start gap-4 text-caption text-state-broken-text"
        >
          <Icon name="alert" tone="broken">
            {alertShape}
          </Icon>
          <span>{message}</span>
        </li>
      ))}
    </ul>
  );
}

export const hiddenValues = (name: string | undefined, values: readonly string[]): ReactNode =>
  name === undefined
    ? null
    : values.map((value) => <input key={value} type="hidden" name={name} value={value} />);
