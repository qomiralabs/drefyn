'use client';
import { IconCross, IconInbox } from '@drefyn/ui/react';
import Link from 'next/link';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { InboxItem } from './data.ts';

// One inbox for the organization. The count is a plain number in a neutral keycap: red
// means broken, and nothing here is broken.
//
// Non modal, so people can read it while they work: the page stays live under it, a press
// outside leaves it open, and it sits right after its trigger in the page, so Tab walks in
// and out of it in reading order. Escape inside it, the trigger and Close shut it. On a
// phone it is a bottom sheet, still without a scrim.
export function Inbox({ items }: { items: readonly InboxItem[] }): ReactNode {
  const count = items.length;
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  // Opening moves focus in, so a screen reader hears the panel's name and the next Tab
  // reaches the first item.
  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    close();
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={count === 0 ? 'Inbox, nothing needs you' : `Inbox, ${count} need you`}
        aria-expanded={open}
        aria-controls={open ? 'inbox-panel' : undefined}
        onClick={(event) => {
          // Safari does not focus a clicked button, and focus must come back here on close.
          event.currentTarget.focus();
          setOpen((was) => !was);
        }}
        onKeyDown={open ? onKeyDown : undefined}
        className="inline-flex h-control-md shrink-0 cursor-pointer items-center gap-4 rounded-sm px-4 text-secondary transition-colors duration-fast ease-enter hover:bg-hover hover:text-ink focus-visible:focus-ring aria-expanded:bg-pressed"
      >
        <IconInbox size="md" />
        {count === 0 ? null : (
          <span
            data-numeric=""
            className="inline-grid h-icon-md place-items-center rounded-xs border border-rule-strong bg-raised px-4 text-label text-body"
          >
            {count}
          </span>
        )}
      </button>
      {open ? (
        <div
          ref={panel}
          id="inbox-panel"
          role="dialog"
          aria-labelledby="inbox-title"
          tabIndex={-1}
          data-inbox=""
          onKeyDown={onKeyDown}
          className="absolute end-12 top-full z-overlay mt-4 flex max-h-inbox w-shell-drawer flex-col overflow-auto rounded-md border border-rule-strong bg-overlay shadow-1 outline-none focus-visible:focus-ring max-sm:fixed max-sm:inset-x-0 max-sm:top-auto max-sm:bottom-0 max-sm:mt-0 max-sm:w-full max-sm:rounded-b-none max-sm:border-b-0 max-sm:pb-safe-bottom max-sm:shadow-2 motion-safe:animate-settle motion-reduce:animate-fade-in"
        >
          <div className="flex items-center justify-between border-b border-rule py-4 ps-12 pe-4">
            <h2 id="inbox-title" className="text-body-s font-medium text-ink">
              Inbox
            </h2>
            <button
              type="button"
              aria-label="Close inbox"
              onClick={close}
              className="inline-grid size-control-md cursor-pointer place-items-center rounded-sm text-secondary transition-colors duration-fast ease-enter hover:bg-hover hover:text-ink focus-visible:focus-ring"
            >
              <IconCross />
            </button>
          </div>
          {count === 0 ? (
            <p className="px-12 py-16 text-body-s text-secondary">Nothing needs you right now.</p>
          ) : (
            <section aria-labelledby="inbox-needs-you" className="flex flex-col">
              <h3
                id="inbox-needs-you"
                className="px-12 pt-12 pb-4 text-label text-secondary uppercase"
              >
                Needs you
              </h3>
              <ul className="flex flex-col">
                {items.map((item) => (
                  <li key={item.id} className="border-b border-rule last:border-b-0">
                    <Link
                      href={item.href}
                      onClick={() => {
                        setOpen(false);
                      }}
                      className="flex flex-col gap-2 px-12 py-8 transition-colors duration-fast ease-enter hover:bg-hover focus-visible:focus-ring-inset"
                    >
                      <span className="text-body-s font-medium text-ink">{item.title}</span>
                      <span className="text-caption text-secondary">
                        {item.where}, {item.when}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      ) : null}
    </>
  );
}
