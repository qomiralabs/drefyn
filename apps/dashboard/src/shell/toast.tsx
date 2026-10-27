'use client';
import type { ReactNode } from 'react';
import {
  Button,
  Text,
  UNSTABLE_Toast as Toast,
  UNSTABLE_ToastContent as ToastContent,
  UNSTABLE_ToastQueue as ToastQueue,
  UNSTABLE_ToastRegion as ToastRegion,
} from 'react-aria-components';
import { durationMs } from './duration.ts';
import { IconClose } from './icons.tsx';

export interface ShellToast {
  readonly message: string;
}

// One queue for the whole shell. Toasts announce through the region's live text and never
// take focus. The region only exists while a toast shows.
export const toasts = new ToastQueue<ShellToast>({ maxVisibleToasts: 3 });

// The wait comes from the timer tokens in tokens.css, so it changes in one place.
function timerMs(name: 'toast' | 'toast-undo'): number | undefined {
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--dr-timer-${name}`);
  return durationMs(value);
}

export function toast(message: string): void {
  const timeout = timerMs('toast');
  // Without a readable timer the toast stays until dismissed, which is never worse.
  toasts.add({ message }, timeout === undefined ? {} : { timeout });
}

export function ShellToasts(): ReactNode {
  return (
    <ToastRegion
      queue={toasts}
      aria-label="Notifications"
      className="fixed inset-x-16 bottom-16 z-toast flex flex-col gap-8 outline-none data-focus-visible:focus-ring sm:start-auto sm:end-24 sm:bottom-24 sm:w-shell-drawer"
    >
      {({ toast: item }) => (
        <Toast
          toast={item}
          className="flex items-start gap-12 rounded-md border border-rule-strong bg-overlay p-12 text-body-s text-body shadow-1 outline-none data-focus-visible:focus-ring"
        >
          <ToastContent className="flex min-w-0 flex-1 flex-col">
            <Text slot="title">{item.content.message}</Text>
          </ToastContent>
          <Button
            slot="close"
            aria-label="Dismiss"
            className="inline-grid size-control-sm shrink-0 cursor-pointer place-items-center rounded-sm text-secondary transition-colors duration-fast ease-enter hover:bg-hover hover:text-ink focus-visible:focus-ring"
          >
            <IconClose />
          </Button>
        </Toast>
      )}
    </ToastRegion>
  );
}
