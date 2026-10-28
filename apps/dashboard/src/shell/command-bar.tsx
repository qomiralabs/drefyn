'use client';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import {
  Autocomplete,
  Dialog,
  Input,
  ListBox,
  ListBoxItem,
  Modal,
  ModalOverlay,
  SearchField,
} from 'react-aria-components';
import { allowed, commandFilter } from './commands.ts';
import { places } from './places.ts';
import { IconSearch } from './icons.tsx';

export interface CommandBarProps {
  org: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Placeholder people may do everything; the permission check is real once sessions exist.
const canEverything = () => true;

export function CommandBar({ org, open, onOpenChange }: CommandBarProps): ReactNode {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const entries = useMemo(() => allowed(places(org), canEverything), [org]);
  const filter = useMemo(() => commandFilter(entries), [entries]);

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
            <SearchField
              aria-label="Search or run a command"
              className="flex items-center gap-8 border-b border-rule px-16 text-secondary"
            >
              <IconSearch size="md" />
              {/* The field drives a listbox through aria-activedescendant, which is the combobox
                  pattern; React Aria leaves the role to the caller. */}
              <Input
                autoFocus
                role="combobox"
                aria-expanded="true"
                aria-haspopup="listbox"
                placeholder="Search or run a command"
                className="h-control-lg min-w-0 flex-1 bg-transparent text-body-m text-ink outline-none placeholder:text-secondary"
              />
            </SearchField>
            <ListBox
              aria-label="Results"
              items={entries}
              onAction={(key) => {
                const entry = entries.find((e) => e.id === key);
                if (entry === undefined) return;
                onOpenChange(false);
                setQuery('');
                router.push(entry.href);
              }}
              renderEmptyState={() => (
                <p className="px-8 py-12 text-body-s text-secondary">
                  Nothing matches &ldquo;{query}&rdquo;.
                </p>
              )}
              className="flex min-h-0 flex-col overflow-auto p-4 outline-none"
            >
              {(entry) => (
                <ListBoxItem
                  id={entry.id}
                  textValue={`${entry.name}, ${entry.kind}`}
                  className="flex min-h-row-compact cursor-default items-center gap-8 rounded-sm px-8 text-body-s text-body outline-none data-focus-visible:focus-ring-inset data-focused:bg-hover data-pressed:bg-pressed"
                >
                  <span className="min-w-0 flex-1 truncate">
                    <span className="text-ink">{entry.name}</span>
                    <span className="text-secondary">, {entry.kind}</span>
                  </span>
                  {entry.shortcut === undefined ? null : (
                    <kbd className="font-mono text-caption text-secondary">{entry.shortcut}</kbd>
                  )}
                </ListBoxItem>
              )}
            </ListBox>
          </Autocomplete>
          <p className="hidden gap-16 border-t border-rule px-16 py-8 text-caption text-secondary sm:flex">
            <span>Enter to open</span>
            <span>Esc to close</span>
          </p>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
