'use client';
import { useEffect, useRef, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import {
  Button as AriaButton,
  Text,
  UNSTABLE_Toast as AriaToast,
  UNSTABLE_ToastContent as ToastContent,
  UNSTABLE_ToastQueue as ToastQueue,
  UNSTABLE_ToastRegion as AriaToastRegion,
  type QueuedToast,
} from 'react-aria-components';
import { tokens } from '../tokens/tokens.ts';
import { buttonClasses, LABEL_CELL } from './button-classes.ts';
import { alertShape } from './icons/alert.tsx';
import { IconCross } from './icons/cross.tsx';
import { Icon } from './icons/icon.tsx';

export type ToastTone = 'neutral' | 'error';

export interface ToastInput {
  // Plain words. Never content bodies or personal data.
  title: string;
  description?: string;
  undo?: () => void | Promise<void>;
  tone?: ToastTone;
}

export interface ToastHandle {
  close(): void;
}

interface Item {
  title: string;
  description?: string;
  tone: ToastTone;
  // Already guarded to run once; it closes the toast before it runs.
  undo?: () => void;
}

// One queue for the page, so toast() works from anywhere, including code that renders
// nothing. Three show at once, newest first; the rest wait their turn.
const queue = new ToastQueue<Item>({ maxVisibleToasts: 3 });

function failedUndo(title: string): void {
  toast({ title: 'Could not undo', description: title, tone: 'error' });
}

// Six seconds, ten with Undo so there is time to reach it, and errors stay until dismissed.
export function toast(input: ToastInput): ToastHandle {
  if (input.title.trim() === '') throw new Error('A toast needs a title to announce.');
  const tone = input.tone ?? 'neutral';
  let key = '';
  let ran = false;
  const original = input.undo;
  const undo =
    original === undefined
      ? undefined
      : () => {
          if (ran) return;
          ran = true;
          queue.close(key);
          // A failed undo says so in an error toast, which never takes focus either.
          try {
            // Promise.resolve adopts any thenable, so a rejection from a promise library or
            // another realm still reaches the catch.
            Promise.resolve(original()).catch(() => {
              failedUndo(input.title);
            });
          } catch {
            failedUndo(input.title);
          }
        };
  const timeout =
    tone === 'error'
      ? undefined
      : undo === undefined
        ? tokens.timer.toast.ms
        : tokens.timer.toastUndo.ms;
  key = queue.add(
    {
      title: input.title,
      tone,
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(undo === undefined ? {} : { undo }),
    },
    timeout === undefined ? {} : { timeout },
  );
  return {
    close: () => {
      queue.close(key);
    },
  };
}

// Inputs that take typed text keep Cmd+Z for their own undo. Checkboxes and buttons have none.
const NOT_TEXT = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

function takesText(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.closest('[contenteditable]:not([contenteditable="false"])')) {
    return true;
  }
  if (el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && !NOT_TEXT.has(el.type);
}

const isUndo = (event: KeyboardEvent) =>
  event.key.toLowerCase() === 'z' &&
  (event.metaKey || event.ctrlKey) &&
  !event.shiftKey &&
  !event.altKey;

// React Aria pauses on hover and focus within; these say whether either holds right now, so
// a hidden tab coming back, or a toast arriving, does not restart a timer that should wait.
const held = (region: RefObject<HTMLDivElement | null>) =>
  region.current !== null &&
  (region.current.hasAttribute('data-hovered') || region.current.contains(document.activeElement));

const REGION =
  'fixed start-16 end-16 bottom-16 mb-safe-bottom z-toast flex flex-col gap-8 text-body-s outline-none data-focus-visible:focus-ring sm:start-24 sm:end-auto sm:bottom-24 sm:w-full sm:max-w-measure';

const CARD =
  'flex items-start gap-8 rounded-md border border-rule-strong bg-overlay py-8 ps-12 pe-8 shadow-1 outline-none data-focus-visible:focus-ring';

function Card({
  item,
  region,
}: {
  item: QueuedToast<Item>;
  region: RefObject<HTMLDivElement | null>;
}): ReactNode {
  const { title, description, tone, undo } = item.content;
  // React Aria starts a toast's timer when it mounts. One that arrives while the tab is
  // hidden or the region is held waits like the others. This runs after React Aria's own
  // effect, because a parent's effects run after its children's.
  useEffect(() => {
    if (document.visibilityState === 'hidden' || held(region)) queue.pauseAll();
  }, [region]);
  return (
    <AriaToast toast={item} className={CARD}>
      {tone === 'error' ? (
        <span className="flex h-row-compact items-center ps-0">
          <Icon name="alert" tone="broken">
            {alertShape}
          </Icon>
        </span>
      ) : null}
      {/* Errors interrupt; anything else waits for a pause in speech. */}
      <ToastContent
        role={tone === 'error' ? 'alert' : 'status'}
        className="flex min-w-0 flex-1 flex-col justify-center py-4"
      >
        <Text slot="title" className="font-medium text-body">
          {title}
        </Text>
        {description === undefined ? null : (
          <Text slot="description" className="text-secondary">
            {description}
          </Text>
        )}
      </ToastContent>
      {/* Same row box as the error icon, so the actions centre on a one line message. */}
      <span className="flex h-row-compact shrink-0 items-center gap-4">
        {undo === undefined ? null : (
          <button
            type="button"
            aria-keyshortcuts="Meta+Z Control+Z"
            onClick={undo}
            className={buttonClasses({ variant: 'accent', size: 'sm', disabled: false })}
          >
            <span className={LABEL_CELL}>Undo</span>
          </button>
        )}
        <AriaButton
          slot="close"
          aria-label="Dismiss"
          className={buttonClasses({
            variant: 'quiet',
            size: 'sm',
            disabled: false,
            iconOnly: true,
          })}
        >
          <IconCross />
        </AriaButton>
      </span>
    </AriaToast>
  );
}

// Mount once per app. It renders nothing until a toast shows, then a notifications landmark
// that F6 reaches. Toasts never take focus.
const subscribe = (onChange: () => void) => queue.subscribe(onChange);
const showing = () => queue.visibleToasts.length > 0;

export function ToastRegion(): ReactNode {
  const region = useRef<HTMLDivElement>(null);
  // React Aria registers the region for F6 only if its element exists when it mounts, and it
  // renders no element while the queue is empty. A new key when the first toast arrives
  // mounts it again with its element, so F6 always finds it.
  const shown = useSyncExternalStore(subscribe, showing, () => false);
  useEffect(() => {
    let pausedForHidden = false;
    const onKeyDown = (event: KeyboardEvent) => {
      // A held key repeats; something that already handled the key keeps it; a text field
      // keeps its own undo.
      if (event.repeat || event.defaultPrevented) return;
      if (!isUndo(event) || takesText(document.activeElement)) return;
      const newest = queue.visibleToasts.find((item) => item.content.undo !== undefined);
      if (newest === undefined) return;
      event.preventDefault();
      newest.content.undo?.();
    };
    // React Aria's timers have no idea of a hidden tab, so a toast would close unseen.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        queue.pauseAll();
        pausedForHidden = true;
      } else if (pausedForHidden) {
        pausedForHidden = false;
        if (!held(region)) queue.resumeAll();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  return (
    <AriaToastRegion
      key={shown ? 'shown' : 'empty'}
      ref={region}
      queue={queue}
      aria-label="Notifications"
      className={REGION}
    >
      {({ toast: item }) => <Card item={item} region={region} />}
    </AriaToastRegion>
  );
}
