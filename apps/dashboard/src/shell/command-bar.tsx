'use client';
import { Badge } from '@drefyn/ui/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import {
  Autocomplete,
  Button,
  Dialog,
  Input,
  ListBox,
  ListBoxItem,
  Modal,
  ModalOverlay,
  SearchField,
} from 'react-aria-components';
import { allowed, commandFilter } from './commands.ts';
import { ICON_BY_NAME, IconClose, IconSearch } from './icons.tsx';
import { places } from './places.ts';

export interface CommandBarProps {
  org: string;
  orgName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Placeholder people may do everything; the permission check is real once sessions exist.
const canEverything = () => true;

const KEYCAP =
  'inline-flex h-icon-md items-center rounded-xs border border-rule-strong px-4 font-mono text-label text-secondary';

const QUIET =
  'inline-grid shrink-0 cursor-pointer place-items-center rounded-sm text-secondary transition-colors duration-fast ease-enter outline-none hover:bg-hover hover:text-ink data-focus-visible:focus-ring';

export function CommandBar({ org, orgName, open, onOpenChange }: CommandBarProps): ReactNode {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const entries = useMemo(() => allowed(places(org), canEverything), [org]);
  const filter = useMemo(() => commandFilter(entries), [entries]);
  const close = () => {
    onOpenChange(false);
    setQuery('');
  };
  // Where the next steps on no results lead until search and creation exist.
  const pages = `/${org}/docs/payments-api/pages`;

  return (
    // No enter fade: React Aria keeps an overlay open if it is closed mid transition, and
    // Cmd+K pressed twice quickly must close it.
    <ModalOverlay
      isOpen={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setQuery('');
      }}
      isDismissable
      className="fixed inset-0 z-overlay flex items-start justify-center bg-overlay-scrim sm:px-16 sm:pt-96"
    >
      <Modal className="flex h-dvh w-full flex-col overflow-hidden bg-overlay shadow-2 sm:h-auto sm:max-w-landing sm:rounded-md sm:border sm:border-rule-strong">
        <Dialog aria-label="Search or run a command" className="flex min-h-0 flex-col outline-none">
          <Autocomplete inputValue={query} onInputChange={setQuery} filter={filter}>
            <div className="flex items-center gap-8 border-b border-rule pe-8 ps-16">
              <SearchField
                aria-label="Search or run a command"
                className="group flex min-w-0 flex-1 items-center gap-8 text-secondary"
              >
                <IconSearch size="md" />
                {/* The field drives a listbox through aria-activedescendant, which is the
                    combobox pattern; React Aria leaves the role to the caller. */}
                <Input
                  autoFocus
                  role="combobox"
                  aria-expanded="true"
                  aria-haspopup="listbox"
                  placeholder="Search or run a command"
                  className="h-control-lg min-w-0 flex-1 bg-transparent text-body-m text-ink outline-none placeholder:text-secondary"
                />
                {/* Inside a SearchField, React Aria wires a Button as its clear button. */}
                <Button
                  aria-label="Clear search"
                  className={`${QUIET} size-control-sm group-data-empty:hidden`}
                >
                  <IconClose />
                </Button>
              </SearchField>
              <span className="shrink-0 rounded-xs border border-rule-strong px-4 text-caption text-secondary">
                In {orgName}
              </span>
              {/* A full screen dialog on a phone has no scrim to tap, so it needs a way out. */}
              <Button
                onPress={close}
                className={`${QUIET} h-control-md px-8 text-body-s sm:hidden`}
              >
                Cancel
              </Button>
            </div>
            <ListBox
              aria-label="Results"
              items={entries}
              onAction={(key) => {
                const entry = entries.find((e) => e.id === key);
                if (entry === undefined) return;
                close();
                router.push(entry.href);
              }}
              renderEmptyState={() => (
                <div className="flex flex-col items-start gap-8 px-8 py-12 text-body-s">
                  <p className="text-secondary">Nothing matches &ldquo;{query}&rdquo;.</p>
                  <Link
                    href={`${pages}?q=${encodeURIComponent(query)}`}
                    onClick={close}
                    className="text-accent-ink underline hover:text-accent-press focus-visible:focus-ring"
                  >
                    Search Payments API docs for &ldquo;{query}&rdquo;
                  </Link>
                  <Link
                    href={`${pages}?new=${encodeURIComponent(query)}`}
                    onClick={close}
                    className="text-accent-ink underline hover:text-accent-press focus-visible:focus-ring"
                  >
                    Create a page called &ldquo;{query}&rdquo;
                  </Link>
                </div>
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
                    <Icon tone="secondary" />
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
          <p className="hidden items-center gap-16 border-t border-rule px-16 py-8 text-caption text-secondary sm:flex">
            <span className="inline-flex items-center gap-4">
              <kbd className={KEYCAP}>↑</kbd>
              <kbd className={KEYCAP}>↓</kbd> to move
            </span>
            <span className="inline-flex items-center gap-4">
              <kbd className={KEYCAP}>Enter</kbd> to open
            </span>
            <span className="inline-flex items-center gap-4">
              <kbd className={KEYCAP}>esc</kbd> to close
            </span>
          </p>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
