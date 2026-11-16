'use client';
import { IconSearch, Skeleton } from '@drefyn/ui/react';
import { useEffect, type ReactNode } from 'react';
import { Button, Dialog, Modal, ModalOverlay } from 'react-aria-components';

// Shared with the results, so the field and its row sit in the same place before and after
// the code lands, and nothing moves under the person's eyes.
export const KEYCAP =
  'inline-flex h-icon-md items-center rounded-xs border border-rule-strong px-4 font-mono text-label text-secondary';
export const QUIET =
  'inline-grid shrink-0 cursor-pointer place-items-center rounded-sm text-secondary transition-colors duration-fast ease-enter outline-none hover:bg-hover hover:text-ink data-focus-visible:focus-ring';
export const FIELD_ROW = 'flex items-center gap-8 border-b border-rule pe-8 ps-16';
export const FIELD_GROUP = 'group flex min-w-0 flex-1 items-center gap-8 text-secondary';
export const FIELD =
  'h-control-lg min-w-0 flex-1 bg-transparent text-body-m text-ink outline-none placeholder:text-secondary';
export const SCOPE =
  'shrink-0 rounded-xs border border-rule-strong px-4 text-caption text-secondary';
export const CANCEL = `${QUIET} h-control-md px-8 text-body-s sm:hidden`;
export const LABEL = 'Search or run a command';

const SKELETON_ROWS = 4;

// What the results need from the shell. The code that draws them loads on the first press.
export interface CommandBodyProps {
  query: string;
  onQueryChange: (query: string) => void;
  close: () => void;
}

// Four rows the size of a result: a square for the icon and a line for the words. They stay
// out of sight for the reveal wait, so a quick load never flashes them; their space is held
// from the start, so the frame does not grow when they appear.
function PendingRows(): ReactNode {
  return (
    <div data-pending-rows="" className="flex flex-col p-4">
      {Array.from({ length: SKELETON_ROWS }, (_, i) => (
        <span key={i} className="flex min-h-row-compact animate-reveal items-center gap-8 px-8">
          <span className="block size-icon-sm shrink-0">
            <Skeleton shape="block" />
          </span>
          <Skeleton width={i % 2 === 0 ? '1/2' : '3/4'} />
        </span>
      ))}
    </div>
  );
}

// The field before the results code arrives. A plain field, so typing starts at once; what
// is typed carries over when the results take its place.
function PendingField({
  query,
  onQueryChange,
  orgName,
  close,
}: CommandBodyProps & { orgName: string }): ReactNode {
  // React Aria's dialog drops aria-busy, so the pending part carries it.
  return (
    <div aria-busy="true" className="flex flex-col">
      <div className={FIELD_ROW}>
        <label className={FIELD_GROUP}>
          <IconSearch size="md" />
          <span className="sr-only">{LABEL}</span>
          <input
            // The dialog has just opened on a key press, and the field is where typing goes.
            autoFocus
            type="text"
            value={query}
            onChange={(event) => {
              onQueryChange(event.target.value);
            }}
            placeholder={LABEL}
            className={FIELD}
          />
        </label>
        <span className={SCOPE}>In {orgName}</span>
        <Button onPress={close} className={CANCEL}>
          Cancel
        </Button>
      </div>
      <PendingRows />
      <p role="status" className="sr-only">
        Loading search
      </p>
    </div>
  );
}

// The command bar's dialog. It opens on the press itself, before its results code has
// loaded; until then it holds the field and skeleton rows, never a spinner.
export function CommandFrame({
  open,
  onOpenChange,
  orgName,
  query,
  onQueryChange,
  body,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgName: string;
  query: string;
  onQueryChange: (query: string) => void;
  body: ((props: CommandBodyProps) => ReactNode) | null;
}): ReactNode {
  const close = () => {
    onOpenChange(false);
  };
  // When the loaded field takes the first one's place, focus rests on the page until the new
  // field takes it, and React Aria hears keys only inside the dialog. An Escape that lands
  // there, handled by nothing, still closes it. The swap can also render inside the Escape's
  // own dispatch, when an earlier listener sets state, and then React finds the key's field
  // gone and runs no handler. A target no longer in the page means the same.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const active = document.activeElement;
      const orphaned = event.target instanceof Node && !event.target.isConnected;
      if (orphaned || active === null || active === document.body) onOpenChange(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onOpenChange]);
  return (
    // No enter fade: React Aria keeps an overlay open if it is closed mid transition, and
    // Cmd+K pressed twice quickly must close it.
    <ModalOverlay
      isOpen={open}
      onOpenChange={onOpenChange}
      isDismissable
      className="fixed inset-0 z-overlay flex items-start justify-center bg-overlay-scrim sm:px-16 sm:pt-96"
    >
      <Modal className="flex h-dvh w-full flex-col overflow-hidden bg-overlay shadow-2 sm:h-auto sm:max-w-landing sm:rounded-md sm:border sm:border-rule-strong">
        <Dialog aria-label={LABEL} className="flex min-h-0 flex-col outline-none">
          {body === null ? (
            <PendingField
              query={query}
              onQueryChange={onQueryChange}
              orgName={orgName}
              close={close}
            />
          ) : (
            body({ query, onQueryChange, close })
          )}
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
