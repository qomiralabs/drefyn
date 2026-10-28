'use client';
import Link from 'next/link';
import { useRef, useState, type ReactNode } from 'react';
import { Dialog, Heading, Popover } from 'react-aria-components';
import type { InboxItem } from './data.ts';
import { IconInbox } from './icons.tsx';

// One inbox for the organization. The count is a plain number in a neutral keycap: red
// means broken, and nothing here is broken.
export function Inbox({ items }: { items: readonly InboxItem[] }): ReactNode {
  const count = items.length;
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={count === 0 ? 'Inbox, nothing needs you' : `Inbox, ${count} need you`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen((was) => !was);
        }}
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
      <Popover
        triggerRef={trigger}
        isOpen={open}
        onOpenChange={setOpen}
        placement="bottom end"
        offset={4}
        className="z-overlay w-shell-drawer overflow-auto rounded-md border border-rule-strong bg-overlay shadow-1 transition-opacity duration-base ease-enter data-entering:opacity-0"
      >
        <Dialog aria-labelledby="inbox-title" className="flex flex-col outline-none">
          <Heading
            id="inbox-title"
            className="border-b border-rule px-12 py-8 text-body-s font-medium text-ink"
          >
            Inbox
          </Heading>
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
        </Dialog>
      </Popover>
    </>
  );
}
