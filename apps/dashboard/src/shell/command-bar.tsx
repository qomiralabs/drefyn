'use client';
import { Badge, IconCross, IconSearch } from '@drefyn/ui/react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react';
import {
  Autocomplete,
  Button,
  Input,
  ListBox,
  ListBoxItem,
  SearchField,
} from 'react-aria-components';
import {
  CANCEL,
  FIELD,
  FIELD_GROUP,
  FIELD_ROW,
  KEYCAP,
  LABEL,
  QUIET,
  SCOPE,
  type CommandBodyProps,
} from './command-frame.tsx';
import { commandFilter, type Command } from './commands.ts';
import type { ShellData } from './data.ts';
import { visiblePlaces } from './places.ts';
import { ICON_BY_NAME } from './section-icons.ts';

// The props the frame passes on, plus what the shell knows. The dialog itself is the frame's,
// so it can open on the press before this code has loaded.
export interface CommandBarProps extends CommandBodyProps {
  org: string;
  orgName: string;
  projects: ShellData['projects'];
  actions: readonly Command[];
  permissions: readonly string[];
}

export function CommandBar({
  org,
  orgName,
  projects,
  actions,
  permissions,
  query,
  onQueryChange,
  close,
}: CommandBarProps): ReactNode {
  const router = useRouter();
  const entries = useMemo(
    () => visiblePlaces(org, permissions, projects, actions),
    [org, permissions, projects, actions],
  );
  const filter = useMemo(() => commandFilter(entries), [entries]);
  // Rows the filter leaves, counted the same way the list filters, for the status line.
  const matches = useMemo(
    () => entries.filter((e) => filter(`${e.name}, ${e.kind}`, query, { key: e.id })).length,
    [entries, filter, query],
  );
  const run = (entry: Command) => {
    close();
    router.push(entry.href);
  };
  // Text typed before this code arrived is kept; the caret goes after it, where typing goes on,
  // and the first row lights up as it would have had the text been typed here. React Aria
  // moves to the first row on a Down press when none is lit.
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = field.current;
    if (el === null) return undefined;
    el.setSelectionRange(el.value.length, el.value.length);
    if (el.value === '') return undefined;
    const frame = requestAnimationFrame(() => {
      if (el.hasAttribute('aria-activedescendant')) return;
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);
  // React Aria names the lit row a moment after it lights, and runs Enter only once it is
  // named. Enter in that moment, or before any row is lit, runs the first match, which is the
  // row that lights.
  const enterWithoutRow = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.currentTarget.hasAttribute('aria-activedescendant')) return;
    const first = entries.find((e) => filter(`${e.name}, ${e.kind}`, query, { key: e.id }));
    if (first === undefined) return;
    event.preventDefault();
    run(first);
  };

  return (
    <>
      <Autocomplete inputValue={query} onInputChange={onQueryChange} filter={filter}>
        <div className={FIELD_ROW}>
          <SearchField aria-label={LABEL} className={FIELD_GROUP}>
            <IconSearch size="md" />
            {/* The field drives a listbox through aria-activedescendant, which is the
                combobox pattern; React Aria leaves the role to the caller. */}
            <Input
              ref={field}
              autoFocus
              onKeyDown={enterWithoutRow}
              role="combobox"
              aria-expanded="true"
              aria-haspopup="listbox"
              placeholder={LABEL}
              className={FIELD}
            />
            {/* Inside a SearchField, React Aria wires a Button as its clear button. */}
            <Button
              aria-label="Clear search"
              className={`${QUIET} size-control-sm group-data-empty:hidden`}
            >
              <IconCross />
            </Button>
          </SearchField>
          <span className={SCOPE}>In {orgName}</span>
          {/* A full screen dialog on a phone has no scrim to tap, so it needs a way out. */}
          <Button onPress={close} className={CANCEL}>
            Cancel
          </Button>
        </div>
        <ListBox
          aria-label="Results"
          items={entries}
          onAction={(key) => {
            const entry = entries.find((e) => e.id === key);
            if (entry === undefined) return;
            run(entry);
          }}
          // React Aria wraps this in a role option, so it holds text only.
          renderEmptyState={() => (
            <p className="px-8 py-12 text-body-s text-secondary">
              Nothing matches &ldquo;{query}&rdquo;.
            </p>
          )}
          className="flex min-h-0 flex-col overflow-auto p-4 outline-none"
        >
          {(entry) => {
            const Icon = ICON_BY_NAME[entry.icon];
            return (
              <ListBoxItem
                id={entry.id}
                textValue={`${entry.name}, ${entry.kind}`}
                // The active row takes the hover fill; the focus ring stays on the field,
                // where keyboard focus really is.
                className="flex min-h-row-compact cursor-default items-center gap-8 rounded-sm px-8 text-body-s text-body outline-none data-focused:bg-hover data-pressed:bg-pressed"
              >
                <span className="inline-flex shrink-0 text-secondary">
                  <Icon />
                </span>
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-ink">{entry.name}</span>
                  <span className="text-secondary">, {entry.kind}</span>
                </span>
                {entry.state === undefined ? null : (
                  <Badge state={entry.state.state} onFill>
                    {entry.state.word}
                  </Badge>
                )}
                {entry.shortcut === undefined ? null : (
                  <kbd className={KEYCAP}>{entry.shortcut}</kbd>
                )}
              </ListBoxItem>
            );
          }}
        </ListBox>
      </Autocomplete>
      {/* Always mounted, so a screen reader hears it when the list empties; the empty
          state itself is never the active row, so it is not read on its own. */}
      <p role="status" className="sr-only">
        {query.trim() !== '' && matches === 0 ? `No results for “${query}”` : ''}
      </p>
    </>
  );
}
