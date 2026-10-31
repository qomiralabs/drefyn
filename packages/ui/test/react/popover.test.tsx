import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tokens } from '../../src/index.ts';
import { Button, IconMore, Popover, Switch } from '../../src/react/index.ts';
import { classesOf } from './classes.ts';

afterEach(cleanup);

function Filters({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  return (
    <div>
      <Button>Before</Button>
      <Popover
        trigger="Filters"
        title="Filter pages"
        {...(onOpenChange === undefined ? {} : { onOpenChange })}
      >
        <Switch>Only stale pages</Switch>
        <Switch>Only pages with drafts</Switch>
      </Popover>
      <Button>After</Button>
    </div>
  );
}

const trigger = () => screen.getByRole('button', { name: 'Filters' });
const panel = () => screen.getByRole('dialog');

describe('Popover', () => {
  it('starts closed behind a trigger that says it opens a dialog', () => {
    render(<Filters />);
    expect(trigger().getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger().getAttribute('aria-expanded')).not.toBe('true');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens a panel named by its heading, with focus inside it', async () => {
    render(<Filters />);
    await userEvent.setup().click(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('dialog', { name: 'Filter pages' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Filter pages' })).toBeDefined();
    expect(panel().contains(document.activeElement)).toBe(true);
  });

  it('is named by its trigger when it has no heading', async () => {
    render(
      <Popover trigger={<IconMore />} triggerLabel="Page details">
        <p>Verified 2 days ago.</p>
      </Popover>,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Page details' }));
    expect(screen.getByRole('dialog', { name: 'Page details' })).toBeDefined();
  });

  it('is not modal: the page outside stays readable', async () => {
    render(<Filters />);
    await userEvent.setup().click(trigger());
    expect(panel().getAttribute('aria-modal')).not.toBe('true');
    const before = screen.getByRole('button', { name: 'Before' });
    expect(before.closest('[aria-hidden="true"]')).toBeNull();
    expect(before.closest('[inert]')).toBeNull();
  });

  it('closes on Escape and gives focus back to the trigger', async () => {
    const user = userEvent.setup();
    render(<Filters />);
    await user.click(trigger());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('closes on a press outside', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<Filters onOpenChange={onOpenChange} />);
    await user.click(trigger());
    fireEvent.pointerDown(document.body);
    fireEvent.pointerUp(document.body);
    fireEvent.click(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
  });

  it('keeps open on a press inside', async () => {
    const user = userEvent.setup();
    render(<Filters />);
    await user.click(trigger());
    await user.click(screen.getByRole('switch', { name: 'Only stale pages' }));
    expect(panel()).toBeDefined();
  });

  it('closes when Tab leaves its last control and moves on from the trigger', async () => {
    const user = userEvent.setup();
    render(<Filters />);
    await user.click(trigger());
    screen.getByRole('switch', { name: 'Only pages with drafts' }).focus();
    await user.keyboard('{Tab}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'After' }));
  });

  it('closes when Shift+Tab leaves its first control and lands on the trigger', async () => {
    const user = userEvent.setup();
    render(<Filters />);
    await user.click(trigger());
    screen.getByRole('switch', { name: 'Only stale pages' }).focus();
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('moves Tab between its own controls without closing', async () => {
    const user = userEvent.setup();
    render(<Filters />);
    await user.click(trigger());
    screen.getByRole('switch', { name: 'Only stale pages' }).focus();
    await user.keyboard('{Tab}');
    expect(panel()).toBeDefined();
    expect(document.activeElement).toBe(
      screen.getByRole('switch', { name: 'Only pages with drafts' }),
    );
  });

  it('closes on a second press of its trigger', async () => {
    const user = userEvent.setup();
    render(<Filters />);
    await user.click(trigger());
    await user.click(trigger());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes when focus moves to another control on the page', async () => {
    const user = userEvent.setup();
    render(<Filters />);
    await user.click(trigger());
    act(() => {
      screen.getByRole('button', { name: 'Before' }).focus();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ignores Ctrl+Tab and Cmd+Tab', async () => {
    const user = userEvent.setup();
    render(<Filters />);
    await user.click(trigger());
    const last = screen.getByRole('switch', { name: 'Only pages with drafts' });
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab', ctrlKey: true });
    fireEvent.keyDown(last, { key: 'Tab', metaKey: true });
    expect(panel()).toBeDefined();
  });

  it('follows open when the caller holds it, and reports closing', async () => {
    function Held() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <output>{open ? 'open' : 'closed'}</output>
          <Popover trigger="Filters" title="Filter pages" open={open} onOpenChange={setOpen}>
            <Switch>Only stale pages</Switch>
          </Popover>
        </>
      );
    }
    render(<Held />);
    expect(panel()).toBeDefined();
    await userEvent.setup().keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('closed')).toBeDefined();
  });

  it('starts open with defaultOpen', () => {
    render(
      <Popover trigger="Filters" title="Filter pages" defaultOpen>
        <p>Nothing to filter yet.</p>
      </Popover>,
    );
    expect(panel()).toBeDefined();
  });

  it('floats on the overlay surface with the strong rule and the first shadow', async () => {
    render(<Filters />);
    await userEvent.setup().click(trigger());
    const surface = panel().closest('[data-popover]') ?? panel();
    expect(classesOf(surface)).toEqual(
      expect.arrayContaining([
        'bg-overlay',
        'border-rule-strong',
        'shadow-1',
        'rounded-md',
        'z-overlay',
      ]),
    );
  });

  it('fades in and travels only under motion-safe, so reduced motion only fades', async () => {
    render(<Filters />);
    await userEvent.setup().click(trigger());
    const surface = panel().closest('[data-popover]') ?? panel();
    const classes = classesOf(surface);
    expect(classes).toContain('transition');
    const moves = classes.filter((c) => c.includes('translate'));
    expect(moves.length).toBeGreaterThan(0);
    for (const c of moves) expect(c).toMatch(/^motion-safe:/);
    // The travel is the enter distance, which happens to sit on the spacing scale.
    const travel = moves.map((c) => /-translate-y-(\d+)$/.exec(c)?.[1]).filter(Boolean);
    expect(travel).toEqual([String(tokens.motion.distance.enter)]);
  });

  it('refuses held state without onOpenChange, and open with defaultOpen, by type', () => {
    const a = (
      // @ts-expect-error open needs onOpenChange.
      <Popover trigger="Filters" open>
        x
      </Popover>
    );
    const b = (
      // @ts-expect-error open and defaultOpen together.
      <Popover trigger="Filters" open defaultOpen onOpenChange={() => undefined}>
        x
      </Popover>
    );
    const c = (
      // @ts-expect-error a popover always has a trigger to anchor to.
      <Popover open onOpenChange={() => undefined}>
        x
      </Popover>
    );
    expect([a, b, c]).toHaveLength(3);
  });
});
