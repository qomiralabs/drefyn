import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button, ButtonLink, IconMore, Tooltip } from '../../src/react/index.ts';
import { tokens } from '../../src/index.ts';
import { classesOf } from './classes.ts';

const DELAY = tokens.timer.tooltip.ms;

beforeEach(() => {
  // Only the clocks: faking microtasks too would stall every await in user-event.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
});

// React Aria keeps tooltips warm across triggers for a moment after one closes, so the
// cool down runs out before the next test, or its hover would open at once.
afterEach(() => {
  cleanup();
  act(() => {
    vi.advanceTimersByTime(DELAY * 10);
  });
  vi.useRealTimers();
});

// user-event stalls under fake timers, so these tests send the events it would. A key press
// before focus is how React Aria learns that focus came from the keyboard.
const keyboardFocus = (el: HTMLElement) => {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab' });
  act(() => {
    el.focus();
  });
};
// A pointer move first, as a real mouse makes, so React Aria knows the pointer is in use.
const hover = (el: HTMLElement) => {
  fireEvent.pointerMove(el, { pointerType: 'mouse' });
  fireEvent.pointerOver(el, { pointerType: 'mouse' });
  fireEvent.pointerEnter(el, { pointerType: 'mouse' });
};
const wait = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

function CopyId() {
  return (
    <>
      <Button>Edit component</Button>
      <Tooltip content="Copy ID">
        <Button variant="quiet" aria-label="Copy ID">
          <IconMore />
        </Button>
      </Tooltip>
    </>
  );
}

const trigger = () => screen.getByRole('button', { name: 'Copy ID' });

describe('Tooltip', () => {
  it('shows nothing at rest and leaves the trigger its own name', () => {
    render(<CopyId />);
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(trigger().getAttribute('aria-label')).toBe('Copy ID');
  });

  it('opens on keyboard focus at once and describes the trigger', () => {
    render(<CopyId />);
    keyboardFocus(trigger());
    expect(document.activeElement).toBe(trigger());
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toBe('Copy ID');
    expect(trigger().getAttribute('aria-describedby')?.split(' ')).toContain(tip.id);
  });

  it('closes on Escape and leaves focus on the trigger', () => {
    render(<CopyId />);
    keyboardFocus(trigger());
    expect(screen.getByRole('tooltip')).toBeDefined();
    fireEvent.keyDown(trigger(), { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it(`opens on hover after the tooltip timer, ${DELAY} ms`, () => {
    render(<CopyId />);
    hover(trigger());
    wait(DELAY - 1);
    expect(screen.queryByRole('tooltip')).toBeNull();
    wait(1);
    expect(screen.getByRole('tooltip').textContent).toBe('Copy ID');
  });

  it('says why a disabled button cannot act, on focus, because it stays focusable', () => {
    const onClick = vi.fn();
    render(
      <Tooltip content="Only owners can publish">
        <Button disabled onClick={onClick}>
          Publish update
        </Button>
      </Tooltip>,
    );
    const button = screen.getByRole('button', { name: 'Publish update' });
    keyboardFocus(button);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('tooltip').textContent).toBe('Only owners can publish');
    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('works on a ButtonLink too', () => {
    render(
      <Tooltip content="Opens the public page">
        <ButtonLink href="/status">View page</ButtonLink>
      </Tooltip>,
    );
    keyboardFocus(screen.getByRole('link', { name: 'View page' }));
    expect(screen.getByRole('tooltip').textContent).toBe('Opens the public page');
  });

  it('can start open, for a story or a test of the open state', () => {
    render(
      <Tooltip content="Copy ID" defaultOpen>
        <Button aria-label="Copy ID">
          <IconMore />
        </Button>
      </Tooltip>,
    );
    expect(screen.getByRole('tooltip').textContent).toBe('Copy ID');
  });

  it('floats on the overlay surface with the strong rule, the small shadow and caption type', () => {
    render(
      <Tooltip content="Copy ID" defaultOpen>
        <Button aria-label="Copy ID">
          <IconMore />
        </Button>
      </Tooltip>,
    );
    expect(classesOf(screen.getByRole('tooltip'))).toEqual(
      expect.arrayContaining([
        'z-overlay',
        'bg-overlay',
        'border',
        'border-rule-strong',
        'shadow-1',
        'rounded-sm',
        'text-caption',
        'text-body',
        'max-w-measure',
      ]),
    );
  });

  it('refuses empty text, which would describe nothing', () => {
    for (const content of ['', '  ']) {
      expect(
        () =>
          render(
            <Tooltip content={content}>
              <Button>Publish update</Button>
            </Tooltip>,
          ),
        JSON.stringify(content),
      ).toThrow(/text/i);
    }
  });

  it('wires a plain Button without React Aria warnings', () => {
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    render(<CopyId />);
    keyboardFocus(trigger());
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('takes text only and no styling props', () => {
    const child = <Button>Publish</Button>;
    // @ts-expect-error content is text, never markup with links or buttons.
    const a = <Tooltip content={<a href="/x">Help</a>} children={child} />;
    // @ts-expect-error no className.
    const b = <Tooltip content="Help" className="x" children={child} />;
    // @ts-expect-error defaultOpen, not isOpen.
    const c = <Tooltip content="Help" isOpen children={child} />;
    expect([a, b, c]).toHaveLength(3);
  });
});
