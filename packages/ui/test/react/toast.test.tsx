import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button, toast, ToastRegion } from '../../src/react/index.ts';
import { tokens } from '../../src/index.ts';
import { classesOf, FORBIDDEN_LOOKS } from './classes.ts';

type Input = Parameters<typeof toast>[0];
type Handle = ReturnType<typeof toast>;

const SHORT = tokens.timer.toast.ms;
const LONG = tokens.timer.toastUndo.ms;

// The queue is shared by every region in the page, as in an app, so each test closes what
// it opened.
const opened: Handle[] = [];
const show = (input: Input): Handle => {
  let handle: Handle | undefined;
  act(() => {
    handle = toast(input);
  });
  if (handle === undefined) throw new Error('toast returned nothing');
  opened.push(handle);
  return handle;
};

const region = () => screen.getByRole('region', { name: /notification/i });
const card = (title: string) => screen.getByRole('alertdialog', { name: title });
const queryCard = (title: string) => screen.queryByRole('alertdialog', { name: title });
const wait = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

beforeEach(() => {
  // Only the clocks: faking microtasks too would stall every await in user-event.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
});

afterEach(() => {
  act(() => {
    for (const handle of opened.splice(0)) handle.close();
  });
  setHidden(false);
  cleanup();
  vi.useRealTimers();
});

// user-event stalls under fake timers, so these tests send the events it would.
// A pointer move first, as a real mouse makes, so React Aria knows the pointer is in use.
const hover = (el: HTMLElement) => {
  fireEvent.pointerMove(el, { pointerType: 'mouse' });
  fireEvent.pointerOver(el, { pointerType: 'mouse' });
  fireEvent.pointerEnter(el, { pointerType: 'mouse' });
};
const unhover = (el: HTMLElement) => {
  fireEvent.pointerOut(el, { pointerType: 'mouse' });
  fireEvent.pointerLeave(el, { pointerType: 'mouse' });
};

describe('toast()', () => {
  it('shows nothing and fails nowhere when no region is mounted', () => {
    const handle = show({ title: 'Link copied' });
    expect(screen.queryByRole('region')).toBeNull();
    act(() => {
      handle.close();
    });
  });

  it('refuses an empty title, which would announce nothing', () => {
    for (const title of ['', '   ']) {
      expect(() => toast({ title }), JSON.stringify(title)).toThrow(/title/i);
    }
  });

  it('shows the title and description in a notifications landmark', () => {
    render(<ToastRegion />);
    show({ title: 'Archived Pricing', description: 'Readers no longer see this page.' });
    const el = card('Archived Pricing');
    expect(within(region()).getByText('Readers no longer see this page.')).toBeDefined();
    expect(el.getAttribute('aria-describedby')).not.toBeNull();
    const description = document.getElementById(el.getAttribute('aria-describedby') ?? '');
    expect(description?.textContent).toBe('Readers no longer see this page.');
  });

  it('never takes focus from where the person was working', () => {
    render(
      <>
        <Button>Archive page</Button>
        <ToastRegion />
      </>,
    );
    const button = screen.getByRole('button', { name: 'Archive page' });
    button.focus();
    show({ title: 'Archived Pricing', undo: () => undefined });
    expect(document.activeElement).toBe(button);
  });

  it('announces politely, and errors assertively', () => {
    render(<ToastRegion />);
    show({ title: 'Link copied' });
    show({ title: 'Could not save the page', tone: 'error' });
    expect(within(card('Link copied')).getByRole('status')).toBeDefined();
    expect(within(card('Link copied')).queryByRole('alert')).toBeNull();
    expect(within(card('Could not save the page')).getByRole('alert')).toBeDefined();
  });

  it(`closes a plain toast after the toast timer, ${SHORT} ms`, () => {
    render(<ToastRegion />);
    show({ title: 'Link copied' });
    wait(SHORT - 1);
    expect(queryCard('Link copied')).not.toBeNull();
    wait(1);
    expect(queryCard('Link copied')).toBeNull();
  });

  it(`keeps a toast with Undo for the longer timer, ${LONG} ms`, () => {
    render(<ToastRegion />);
    show({ title: 'Archived Pricing', undo: () => undefined });
    wait(LONG - 1);
    expect(queryCard('Archived Pricing')).not.toBeNull();
    wait(1);
    expect(queryCard('Archived Pricing')).toBeNull();
  });

  it('keeps an error until it is dismissed', () => {
    render(<ToastRegion />);
    show({ title: 'Could not save the page', tone: 'error' });
    wait(LONG * 10);
    const el = card('Could not save the page');
    fireEvent.click(within(el).getByRole('button', { name: 'Dismiss' }));
    expect(queryCard('Could not save the page')).toBeNull();
  });

  it('closes from its handle', () => {
    render(<ToastRegion />);
    const handle = show({ title: 'Link copied' });
    act(() => {
      handle.close();
    });
    expect(queryCard('Link copied')).toBeNull();
  });

  it('shows three at most, newest first, and the next one when a slot frees', () => {
    render(<ToastRegion />);
    const first = show({ title: 'First' });
    show({ title: 'Second' });
    show({ title: 'Third' });
    show({ title: 'Fourth' });
    const titles = () =>
      within(region())
        .getAllByRole('alertdialog')
        .map((el) => el.getAttribute('aria-label') ?? el.textContent);
    expect(within(region()).getAllByRole('alertdialog')).toHaveLength(3);
    expect(queryCard('First')).toBeNull();
    expect(titles()[0]).toMatch(/Fourth/);
    act(() => {
      opened[3]?.close();
    });
    expect(queryCard('First')).not.toBeNull();
    act(() => {
      first.close();
    });
  });
});

describe('Undo', () => {
  it('is a button named Undo that announces its shortcut', () => {
    render(<ToastRegion />);
    show({ title: 'Archived Pricing', undo: () => undefined });
    const undo = within(card('Archived Pricing')).getByRole('button', { name: 'Undo' });
    expect(undo.getAttribute('aria-keyshortcuts')).toBe('Meta+Z Control+Z');
  });

  it('is only there when the action can be undone', () => {
    render(<ToastRegion />);
    show({ title: 'Link copied' });
    expect(within(card('Link copied')).queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('runs once and closes the toast', () => {
    const undo = vi.fn();
    render(<ToastRegion />);
    show({ title: 'Archived Pricing', undo });
    const button = within(card('Archived Pricing')).getByRole('button', { name: 'Undo' });
    fireEvent.click(button);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(queryCard('Archived Pricing')).toBeNull();
  });

  it('runs from Cmd+Z or Ctrl+Z on the newest undoable toast when focus is not in a text field', () => {
    const older = vi.fn();
    const newer = vi.fn();
    render(
      <>
        <Button>Archive page</Button>
        <ToastRegion />
      </>,
    );
    show({ title: 'Archived Pricing', undo: older });
    show({ title: 'Archived Changelog', undo: newer });
    show({ title: 'Link copied' });
    screen.getByRole('button', { name: 'Archive page' }).focus();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'z', metaKey: true });
    expect(newer).toHaveBeenCalledTimes(1);
    expect(older).not.toHaveBeenCalled();
    expect(queryCard('Archived Changelog')).toBeNull();
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    expect(older).toHaveBeenCalledTimes(1);
    expect(newer).toHaveBeenCalledTimes(1);
    expect(queryCard('Archived Pricing')).toBeNull();
    // Nothing left to undo: the next press does nothing at all.
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    expect(older).toHaveBeenCalledTimes(1);
    expect(newer).toHaveBeenCalledTimes(1);
  });

  it('runs at most once, even when the button and the shortcut race', () => {
    const undo = vi.fn();
    render(<ToastRegion />);
    show({ title: 'Archived Pricing', undo });
    const button = within(card('Archived Pricing')).getByRole('button', { name: 'Undo' });
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    fireEvent.click(button);
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    expect(undo).toHaveBeenCalledTimes(1);
  });

  // Without the guard both presses in one frame reach the handler, because the card has not
  // gone yet: this is the test that fails when the guard is removed.
  it('runs once when two presses land in the same frame', () => {
    const undo = vi.fn();
    render(<ToastRegion />);
    show({ title: 'Archived Pricing', undo });
    const button = within(card('Archived Pricing')).getByRole('button', { name: 'Undo' });
    act(() => {
      button.click();
      button.click();
    });
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('runs once when a press and the shortcut land in the same frame', () => {
    const undo = vi.fn();
    render(<ToastRegion />);
    show({ title: 'Archived Pricing', undo });
    const button = within(card('Archived Pricing')).getByRole('button', { name: 'Undo' });
    act(() => {
      button.click();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true }));
    });
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('ignores a held key, so auto repeat never undoes a run of toasts', () => {
    const first = vi.fn();
    const second = vi.fn();
    render(<ToastRegion />);
    show({ title: 'Archived Pricing', undo: first });
    show({ title: 'Archived Changelog', undo: second });
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true, repeat: true });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('leaves the shortcut alone when something else already handled it', () => {
    const undo = vi.fn();
    render(<ToastRegion />);
    show({ title: 'Archived Pricing', undo });
    const claim = (event: KeyboardEvent) => {
      event.preventDefault();
    };
    document.body.addEventListener('keydown', claim);
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    document.body.removeEventListener('keydown', claim);
    expect(undo).not.toHaveBeenCalled();
    expect(queryCard('Archived Pricing')).not.toBeNull();
  });

  it('says so when an undo throws before it returns', () => {
    render(<ToastRegion />);
    show({
      title: 'Archived Pricing',
      undo: () => {
        throw new Error('offline');
      },
    });
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    const failed = card('Could not undo');
    expect(within(failed).getByText('Archived Pricing')).toBeDefined();
    fireEvent.click(within(failed).getByRole('button', { name: 'Dismiss' }));
  });

  it('says so when an undo returns a thenable that is not a native promise and rejects', async () => {
    render(<ToastRegion />);
    const thenable = {
      then(_resolve: () => void, reject: (reason: unknown) => void) {
        reject(new Error('offline'));
      },
    };
    show({ title: 'Archived Pricing', undo: () => thenable as unknown as Promise<void> });
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const failed = card('Could not undo');
    expect(within(failed).getByText('Archived Pricing')).toBeDefined();
    fireEvent.click(within(failed).getByRole('button', { name: 'Dismiss' }));
  });

  it('leaves Cmd+Z to a text field, a text area and editable content', () => {
    const undo = vi.fn();
    render(
      <>
        <label>
          Title <input type="text" defaultValue="Pricing" />
        </label>
        <label>
          Summary <textarea defaultValue="Plans and limits" />
        </label>
        <div contentEditable suppressContentEditableWarning aria-label="Body" role="textbox">
          Text
        </div>
        <ToastRegion />
      </>,
    );
    show({ title: 'Archived Pricing', undo });
    for (const el of [
      screen.getByRole('textbox', { name: 'Title' }),
      screen.getByRole('textbox', { name: 'Summary' }),
      screen.getByRole('textbox', { name: 'Body' }),
    ]) {
      el.focus();
      fireEvent.keyDown(el, { key: 'z', metaKey: true });
      fireEvent.keyDown(el, { key: 'z', ctrlKey: true });
    }
    expect(undo).not.toHaveBeenCalled();
    expect(queryCard('Archived Pricing')).not.toBeNull();
  });

  it('still runs from the shortcut when focus is on a checkbox, which has no undo of its own', () => {
    const undo = vi.fn();
    render(
      <>
        <label>
          Notify readers <input type="checkbox" />
        </label>
        <ToastRegion />
      </>,
    );
    show({ title: 'Archived Pricing', undo });
    const box = screen.getByRole('checkbox', { name: 'Notify readers' });
    box.focus();
    fireEvent.keyDown(box, { key: 'z', metaKey: true });
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('ignores redo and other modifier forms', () => {
    const undo = vi.fn();
    render(<ToastRegion />);
    show({ title: 'Archived Pricing', undo });
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true, shiftKey: true });
    fireEvent.keyDown(document.body, { key: 'Z', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true, altKey: true });
    fireEvent.keyDown(document.body, { key: 'z' });
    expect(undo).not.toHaveBeenCalled();
  });

  it('says so in an error toast, without taking focus, when undo fails', async () => {
    const undo = vi.fn(() => Promise.reject(new Error('network')));
    render(
      <>
        <Button>Archive page</Button>
        <ToastRegion />
      </>,
    );
    const button = screen.getByRole('button', { name: 'Archive page' });
    button.focus();
    show({ title: 'Archived Pricing', undo });
    fireEvent.keyDown(button, { key: 'z', metaKey: true });
    await act(async () => {
      await Promise.resolve();
    });
    const failed = card('Could not undo');
    expect(within(failed).getByRole('alert')).toBeDefined();
    expect(within(failed).getByText('Archived Pricing')).toBeDefined();
    expect(document.activeElement).toBe(button);
    // It stays, as errors do, until dismissed.
    wait(LONG * 10);
    fireEvent.click(within(card('Could not undo')).getByRole('button', { name: 'Dismiss' }));
    expect(queryCard('Could not undo')).toBeNull();
  });
});

describe('the toast timer', () => {
  it('waits while the pointer is over the region, and resumes where it stopped', () => {
    render(<ToastRegion />);
    show({ title: 'Link copied' });
    wait(SHORT / 2);
    hover(card('Link copied'));
    wait(SHORT * 2);
    expect(queryCard('Link copied')).not.toBeNull();
    unhover(card('Link copied'));
    wait(SHORT / 2 - 50);
    expect(queryCard('Link copied')).not.toBeNull();
    wait(100);
    expect(queryCard('Link copied')).toBeNull();
  });

  it('waits while focus is inside the region', () => {
    render(
      <>
        <Button>Archive page</Button>
        <ToastRegion />
      </>,
    );
    show({ title: 'Archived Pricing', undo: () => undefined });
    act(() => {
      within(card('Archived Pricing')).getByRole('button', { name: 'Undo' }).focus();
    });
    wait(LONG * 2);
    expect(queryCard('Archived Pricing')).not.toBeNull();
    act(() => {
      screen.getByRole('button', { name: 'Archive page' }).focus();
    });
    wait(LONG);
    expect(queryCard('Archived Pricing')).toBeNull();
  });

  it('waits while the window is hidden', () => {
    render(<ToastRegion />);
    show({ title: 'Link copied' });
    wait(SHORT / 2);
    setHidden(true);
    wait(SHORT * 3);
    expect(queryCard('Link copied')).not.toBeNull();
    setHidden(false);
    wait(SHORT / 2 - 50);
    expect(queryCard('Link copied')).not.toBeNull();
    wait(100);
    expect(queryCard('Link copied')).toBeNull();
  });

  it('does not start a toast that arrives while the window is hidden', () => {
    render(<ToastRegion />);
    setHidden(true);
    show({ title: 'Link copied' });
    wait(SHORT * 3);
    expect(queryCard('Link copied')).not.toBeNull();
    setHidden(false);
    wait(SHORT);
    expect(queryCard('Link copied')).toBeNull();
  });
});

describe('the toast look', () => {
  it('sits bottom left above everything, on the overlay surface like a menu', () => {
    render(<ToastRegion />);
    show({ title: 'Link copied' });
    const area = classesOf(region());
    expect(area).toEqual(
      expect.arrayContaining(['fixed', 'z-toast', 'bottom-16', 'start-16', 'mb-safe-bottom']),
    );
    expect(area.filter((c) => /(^|:)(right|end)-(?!auto)/.test(c) && c.startsWith('sm:'))).toEqual(
      [],
    );
    expect(classesOf(card('Link copied'))).toEqual(
      expect.arrayContaining([
        'bg-overlay',
        'border',
        'border-rule-strong',
        'shadow-1',
        'rounded-md',
      ]),
    );
  });

  it('draws Undo in accent ink as a quiet button, and Dismiss as a quiet icon button', () => {
    render(<ToastRegion />);
    show({ title: 'Archived Pricing', undo: () => undefined });
    const el = card('Archived Pricing');
    const undo = classesOf(within(el).getByRole('button', { name: 'Undo' }));
    expect(undo).toEqual(expect.arrayContaining(['text-accent-ink', 'focus-visible:focus-ring']));
    expect(undo.filter((c) => c.startsWith('bg-'))).toEqual([]);
    const dismiss = within(el).getByRole('button', { name: 'Dismiss' });
    expect(classesOf(dismiss)).toEqual(
      expect.arrayContaining(['text-secondary', 'size-control-sm']),
    );
    expect(dismiss.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('marks an error with the alert shape in the broken colour beside its words', () => {
    render(<ToastRegion />);
    show({ title: 'Could not save the page', tone: 'error' });
    const icon = card('Could not save the page').querySelector('svg[data-icon="alert"]');
    if (icon === null) throw new Error('no alert icon');
    expect(classesOf(icon)).toContain('text-state-broken-mark');
    expect(icon.getAttribute('aria-hidden')).toBe('true');
  });

  it('draws no state mark on a plain toast', () => {
    render(<ToastRegion />);
    show({ title: 'Link copied' });
    expect(card('Link copied').querySelector('svg[data-icon="alert"]')).toBeNull();
  });

  it('never dims, loops or moves behind a variant', () => {
    render(<ToastRegion />);
    show({ title: 'Archived Pricing', undo: () => undefined });
    const all = [region(), ...region().querySelectorAll('*')].flatMap((el) => classesOf(el));
    for (const pattern of FORBIDDEN_LOOKS) {
      expect(
        all.filter((c) => pattern.test(c)),
        String(pattern),
      ).toEqual([]);
    }
  });
});

// Any order of the ways a person or a timer can end a toast. Each step happens to the one
// toast with Undo; a tick moves the clock by up to twice its wait.
type Step =
  | { kind: 'undo-click' }
  | { kind: 'meta-z' }
  | { kind: 'ctrl-z' }
  | { kind: 'dismiss' }
  | { kind: 'close' }
  | { kind: 'tick'; ms: number };

const step: fc.Arbitrary<Step> = fc.oneof(
  fc.constant({ kind: 'undo-click' as const }),
  fc.constant({ kind: 'meta-z' as const }),
  fc.constant({ kind: 'ctrl-z' as const }),
  fc.constant({ kind: 'dismiss' as const }),
  fc.constant({ kind: 'close' as const }),
  fc.record({ kind: fc.constant('tick' as const), ms: fc.integer({ min: 0, max: LONG * 2 }) }),
);

describe('toast() under any sequence of steps', () => {
  it('runs Undo at most once, and never from Cmd or Ctrl+Z once the toast is gone', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 12 }), (steps) => {
        const { unmount } = render(<ToastRegion />);
        let runs = 0;
        const handle = show({
          title: 'Archived Pricing',
          undo: () => {
            runs += 1;
          },
        });
        try {
          for (const s of steps) {
            const before = runs;
            const present = queryCard('Archived Pricing') !== null;
            act(() => {
              const el = queryCard('Archived Pricing');
              if (s.kind === 'undo-click' && el !== null) {
                fireEvent.click(within(el).getByRole('button', { name: 'Undo' }));
              } else if (s.kind === 'meta-z') {
                fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
              } else if (s.kind === 'ctrl-z') {
                fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
              } else if (s.kind === 'dismiss' && el !== null) {
                fireEvent.click(within(el).getByRole('button', { name: 'Dismiss' }));
              } else if (s.kind === 'close') {
                handle.close();
              } else if (s.kind === 'tick') {
                vi.advanceTimersByTime(s.ms);
              }
            });
            expect(runs).toBeLessThanOrEqual(1);
            // A toast that timed out, was dismissed or closed takes no shortcut.
            if (!present && (s.kind === 'meta-z' || s.kind === 'ctrl-z')) {
              expect(runs).toBe(before);
            }
          }
        } finally {
          act(() => {
            handle.close();
          });
          unmount();
        }
      }),
      { numRuns: 200 },
    );
  });
});
