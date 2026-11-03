'use client';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Autocomplete,
  Button as AriaButton,
  Collection,
  Dialog as AriaDialog,
  Header,
  Input,
  ListBox,
  ListBoxItem,
  ListBoxSection,
  Modal,
  ModalOverlay,
  SearchField,
  Text,
  useFilter,
  type Key,
} from 'react-aria-components';
import { markDisabled } from './field-parts.tsx';
import { alertShape } from './icons/alert.tsx';
import { IconCross } from './icons/cross.tsx';
import { Icon } from './icons/icon.tsx';
import { IconSearch } from './icons/search.tsx';
import { Skeleton } from './skeleton.tsx';

export interface CommandItem {
  id: string;
  // What the row does or where it goes, as the person would say it.
  label: string;
  // Where it lives, shown after the label in secondary text and matched by the search.
  context?: string;
  // Rows that share a group word are listed under it; the word is matched too.
  group?: string;
  icon?: ReactNode;
  // A key that runs it outside the bar, shown as a keycap and read as aria-keyshortcuts.
  shortcut?: string;
  // Stays reachable by the arrows and announces as unavailable; never runs.
  disabled?: boolean;
  // Why it is unavailable, shown under it and read as its description.
  reason?: string;
}

export interface CommandBarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: readonly CommandItem[];
  // Runs after the bar closes.
  onAction: (id: string) => void;
  // Names the dialog and the field.
  label?: string;
  // What the search covers, such as "In Acme", shown beside the field.
  scope?: string;
  // The query each opening starts from, such as text the person had selected.
  defaultQuery?: string;
  // Each change of the query, for a caller that searches elsewhere.
  onQueryChange?: (query: string) => void;
  // Results are on their way: skeleton rows under the field, which never moves.
  loading?: boolean;
  // Why the search failed. The list then holds one Retry row.
  error?: string;
  onRetry?: () => void;
}

const RETRY = '__retry';
const SKELETON_ROWS = 4;

const KEYCAP =
  'inline-flex h-icon-md items-center rounded-xs border border-rule-strong px-4 font-mono text-label text-secondary';
const QUIET =
  'inline-grid shrink-0 cursor-pointer place-items-center rounded-sm text-secondary transition-colors duration-fast ease-enter outline-none hover:bg-hover hover:text-ink data-focus-visible:focus-ring';
// The highlighted row takes the hover fill; the keyboard stays in the field, so the row has
// no ring. A disabled row keeps its place but takes no fill.
const ROW_BASE =
  'flex min-h-row-compact items-center gap-8 rounded-sm px-8 py-4 text-body-s outline-none max-sm:min-h-row-comfortable';
const ROW_LIVE = 'cursor-default text-body data-focused:bg-hover data-pressed:bg-pressed';
const ROW_DISABLED = 'cursor-not-allowed text-disabled-text';

// React Aria skips disabled rows in arrow navigation unless the collection's disabled
// behaviour is 'selection', which ListBox passes to its state without typing the prop.
const REACHABLE_WHEN_DISABLED = { disabledBehavior: 'selection' } as Record<string, unknown>;

interface Group {
  id: string;
  name: string;
  items: CommandItem[];
}

// Groups in the order their first row appears. Rows without a group go first, unheaded.
function groupsOf(items: readonly CommandItem[]): Group[] {
  const groups = new Map<string, Group>();
  for (const item of items) {
    const name = item.group ?? '';
    const group = groups.get(name) ?? { id: `group:${name}`, name, items: [] };
    group.items.push(item);
    groups.set(name, group);
  }
  return [...groups.values()].sort((a, b) => (a.name === '' ? -1 : b.name === '' ? 1 : 0));
}

const searchText = (item: CommandItem): string =>
  [item.label, item.context, item.group].filter((part) => part !== undefined).join(', ');

// The key is a shortcut, not part of the name, so it is read from aria-keyshortcuts, which
// React Aria filters out of an item's props.
const markRow = (item: CommandItem) => (el: HTMLElement | null) => {
  markDisabled(item.disabled === true)(el);
  if (el === null) return;
  if (item.shortcut === undefined) el.removeAttribute('aria-keyshortcuts');
  else el.setAttribute('aria-keyshortcuts', item.shortcut);
};

function CommandRow({ item }: { item: CommandItem }): ReactNode {
  const disabled = item.disabled === true;
  return (
    <ListBoxItem
      id={item.id}
      textValue={searchText(item)}
      ref={markRow(item)}
      className={`${ROW_BASE} ${disabled ? ROW_DISABLED : ROW_LIVE}`}
    >
      {item.icon === undefined ? null : (
        <span
          className={`inline-flex shrink-0 ${disabled ? 'text-disabled-text' : 'text-secondary'}`}
        >
          {item.icon}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <Text slot="label" className="truncate">
          <span data-label="" className={disabled ? undefined : 'text-ink'}>
            {item.label}
          </span>
          {item.context === undefined ? null : (
            <span className="text-secondary">, {item.context}</span>
          )}
        </Text>
        {disabled && item.reason !== undefined ? (
          // The reason keeps the secondary colour, so it reads; only the label is disabled.
          <Text slot="description" className="text-caption text-secondary">
            {item.reason}
          </Text>
        ) : null}
      </span>
      {item.shortcut === undefined ? null : <kbd className={KEYCAP}>{item.shortcut}</kbd>}
    </ListBoxItem>
  );
}

function LoadingRows(): ReactNode {
  return (
    <span data-skeleton="" className="flex flex-col">
      <span className="sr-only">Loading results</span>
      {Array.from({ length: SKELETON_ROWS }, (_, i) => (
        <span key={i} className="flex min-h-row-compact items-center px-8">
          <Skeleton width={i % 2 === 0 ? '3/4' : '1/2'} />
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

// The body mounts each time the bar opens, so every opening starts from the default query.
function Body({
  items,
  onAction,
  close,
  label,
  scope,
  defaultQuery = '',
  onQueryChange,
  loading,
  error,
  onRetry,
}: Omit<CommandBarProps, 'open' | 'onOpenChange' | 'label'> & {
  label: string;
  close: () => void;
}): ReactNode {
  const [query, setQuery] = useState(defaultQuery);
  const field = useRef<HTMLInputElement>(null);
  // React Aria's dialog focuses itself when it mounts. This effect runs after the dialog's,
  // since the dialog is a child here, so the field has the last word.
  useEffect(() => {
    field.current?.focus();
  }, []);
  const { contains } = useFilter({ sensitivity: 'base' });
  const failed = error !== undefined && error.trim() !== '';
  const shown = useMemo(
    () => (failed ? [] : loading === true ? [] : items),
    [failed, loading, items],
  );
  const groups = useMemo(() => groupsOf(shown), [shown]);
  const grouped = groups.some((g) => g.name !== '');
  const disabledKeys = shown.filter((i) => i.disabled === true).map((i) => i.id);
  const matches = shown.filter((i) => contains(searchText(i), query)).length;

  const run = (key: Key) => {
    const id = String(key);
    if (id === RETRY) {
      onRetry?.();
      return;
    }
    const item = shown.find((i) => i.id === id);
    if (item === undefined || item.disabled === true) return;
    close();
    onAction(id);
  };

  const empty = () =>
    loading === true ? (
      <LoadingRows />
    ) : (
      // React Aria wraps this in a role option, so it holds text only.
      <p className="px-8 py-12 text-body-s text-secondary">
        Nothing matches &ldquo;{query}&rdquo;.
      </p>
    );

  const listProps = {
    ...REACHABLE_WHEN_DISABLED,
    ref: markBusy(loading === true),
    'aria-label': 'Results',
    disabledKeys,
    onAction: run,
    renderEmptyState: empty,
    className: 'flex min-h-0 flex-col overflow-auto p-4 outline-none',
  };

  return (
    <AriaDialog aria-label={label} className="flex min-h-0 flex-1 flex-col outline-none">
      <Autocomplete
        inputValue={query}
        onInputChange={(next) => {
          setQuery(next);
          onQueryChange?.(next);
        }}
        // The Retry row stays whatever the query, so a failed search can always be retried.
        filter={(text, input, node) => node.key === RETRY || contains(text, input)}
      >
        <div className="flex items-center gap-8 border-b border-rule ps-16 pe-8">
          <SearchField
            aria-label={label}
            className="group flex min-w-0 flex-1 items-center gap-8 text-secondary"
          >
            <IconSearch size="md" />
            {/* The field drives the list through aria-activedescendant, which is the combobox
                pattern; React Aria leaves the role and the popup to the caller. */}
            <Input
              ref={field}
              data-command-field=""
              role="combobox"
              aria-expanded="true"
              aria-haspopup="listbox"
              placeholder={label}
              className="h-control-lg min-w-0 flex-1 bg-transparent text-body-m text-ink outline-none placeholder:text-secondary"
            />
            {/* Inside a SearchField, React Aria wires a Button as its clear button. */}
            <AriaButton
              aria-label="Clear search"
              className={`${QUIET} size-control-sm group-data-empty:hidden`}
            >
              <IconCross />
            </AriaButton>
          </SearchField>
          {scope === undefined ? null : (
            <span className="shrink-0 rounded-xs border border-rule-strong px-4 text-caption text-secondary">
              {scope}
            </span>
          )}
          {/* A full screen bar on a phone has no scrim to tap, so it needs a way out. */}
          <AriaButton
            onPress={close}
            className={`${QUIET} h-control-md px-8 text-body-s sm:hidden`}
          >
            Cancel
          </AriaButton>
        </div>
        {failed ? (
          <p
            role="alert"
            className="flex items-center gap-8 border-b border-rule px-16 py-8 text-body-s text-state-broken-text"
          >
            <Icon name="alert" tone="broken">
              {alertShape}
            </Icon>
            {error}
          </p>
        ) : null}
        {failed ? (
          <ListBox {...listProps}>
            <ListBoxItem id={RETRY} textValue="Retry" className={`${ROW_BASE} ${ROW_LIVE}`}>
              <span data-label="" className="text-ink">
                Retry
              </span>
            </ListBoxItem>
          </ListBox>
        ) : grouped ? (
          <ListBox {...listProps} items={groups}>
            {(group) => (
              <ListBoxSection id={group.id} className="flex flex-col pb-4">
                {group.name === '' ? null : (
                  <Header className="px-8 pt-8 pb-4 text-label font-medium text-secondary uppercase">
                    {group.name}
                  </Header>
                )}
                <Collection items={group.items}>{(item) => <CommandRow item={item} />}</Collection>
              </ListBoxSection>
            )}
          </ListBox>
        ) : (
          <ListBox {...listProps} items={shown}>
            {(item) => <CommandRow item={item} />}
          </ListBox>
        )}
      </Autocomplete>
      {/* Always mounted, so a screen reader hears it when the list empties; the empty state
          itself is never the active row, so it is not read on its own. */}
      <p role="status" className="sr-only">
        {!failed && loading !== true && query.trim() !== '' && matches === 0
          ? `No results for “${query}”`
          : ''}
      </p>
      <p className="hidden items-center gap-16 border-t border-rule px-16 py-8 text-caption text-secondary sm:flex">
        <span className="inline-flex items-center gap-4">
          <kbd className={KEYCAP}>Up</kbd>
          <kbd className={KEYCAP}>Down</kbd> to move
        </span>
        <span className="inline-flex items-center gap-4">
          <kbd className={KEYCAP}>Enter</kbd> to run
        </span>
        <span className="inline-flex items-center gap-4">
          <kbd className={KEYCAP}>Esc</kbd> to close
        </span>
      </p>
    </AriaDialog>
  );
}

// The command bar primitive the shell builds Cmd+K on: a React Aria Autocomplete with a
// search field driving a listbox, inside a modal on the scrim. The shell owns the shortcut
// and the registry; this owns the keyboard model. Focus stays in the field and the arrows
// move the highlighted row, which the field names through aria-activedescendant. Enter runs
// it and closes. Escape clears the query, then closes, and focus returns to what opened it.
// Rows that share a group word are listed under it. On a phone the bar fills the screen.
// No enter fade: React Aria keeps an overlay open if it closes mid transition, and the
// shortcut pressed twice quickly must close it.
export function CommandBar({
  open,
  onOpenChange,
  label = 'Search or run a command',
  ...rest
}: CommandBarProps): ReactNode {
  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={onOpenChange}
      isDismissable
      className="fixed inset-0 z-overlay flex items-start justify-center bg-overlay-scrim sm:px-16 sm:pt-96"
    >
      <Modal className="flex h-dvh w-full flex-col overflow-hidden bg-overlay pb-safe-bottom shadow-2 outline-none sm:h-auto sm:max-h-full sm:max-w-landing sm:rounded-md sm:border sm:border-rule-strong sm:pb-0">
        <Body
          {...rest}
          label={label}
          close={() => {
            onOpenChange(false);
          }}
        />
      </Modal>
    </ModalOverlay>
  );
}
