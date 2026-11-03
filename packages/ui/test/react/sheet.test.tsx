import { act, cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Dialog,
  Menu,
  MenuItem,
  Popover,
  Select,
  SelectOption,
  Switch,
} from '../../src/react/index.ts';
import { classesOf, only } from './classes.ts';

// happy-dom answers matchMedia from the window size, so each test sets the width it needs.
function atWidth(width: number): void {
  const window_ = window as unknown as { happyDOM: { setViewport(v: { width: number }): void } };
  act(() => {
    window_.happyDOM.setViewport({ width });
  });
}

beforeEach(() => {
  atWidth(390);
});
afterEach(() => {
  cleanup();
  atWidth(1024);
});

function Region({ onChange }: { onChange?: (value: string) => void }) {
  return (
    <Select label="Region" placeholder="Choose a region" {...(onChange ? { onChange } : {})}>
      <SelectOption value="eu" description="Frankfurt and Dublin">
        Europe
      </SelectOption>
      <SelectOption value="us">United States</SelectOption>
      <SelectOption value="ap" disabled description="Not on your plan">
        Asia Pacific
      </SelectOption>
    </Select>
  );
}

function Actions({ onAction }: { onAction?: (id: string) => void }) {
  return (
    <Menu trigger="Payments API" {...(onAction ? { onAction } : {})}>
      <MenuItem id="open">Open monitor</MenuItem>
      <MenuItem id="hide" disabled reason="Only an owner can hide a component">
        Hide from audience
      </MenuItem>
      <MenuItem id="copy">Copy ID</MenuItem>
    </Menu>
  );
}

const sheet = () => screen.getByRole('dialog');
const isSheet = (el: HTMLElement) => el.closest('[data-sheet]') !== null;

describe('the phone sheet', () => {
  it('opens a select in a sheet titled by its label below the small breakpoint', async () => {
    render(<Region />);
    await userEvent.setup().click(screen.getByRole('button', { name: /Region/ }));
    const panel = sheet();
    expect(isSheet(panel)).toBe(true);
    expect(within(panel).getByRole('heading', { name: 'Region' })).toBeDefined();
    expect(within(panel).getByRole('listbox')).toBeDefined();
    expect(document.querySelector('[data-select-popover]')).toBeNull();
  });

  it('keeps the anchored list at the small breakpoint and wider', async () => {
    atWidth(640);
    render(<Region />);
    await userEvent.setup().click(screen.getByRole('button', { name: /Region/ }));
    expect(screen.getByRole('listbox').closest('[data-sheet]')).toBeNull();
    expect(document.querySelector('[data-select-popover]')).not.toBeNull();
  });

  it('switches to the sheet when the window narrows while closed', async () => {
    atWidth(1024);
    render(<Region />);
    atWidth(390);
    await userEvent.setup().click(screen.getByRole('button', { name: /Region/ }));
    expect(isSheet(screen.getByRole('listbox'))).toBe(true);
  });

  it('draws the scrim, the safe area and the overlay surface', async () => {
    render(<Region />);
    await userEvent.setup().click(screen.getByRole('button', { name: /Region/ }));
    const overlay = only(document.querySelectorAll('[data-sheet]'));
    expect(classesOf(overlay)).toContain('bg-overlay-scrim');
    expect(classesOf(overlay)).toContain('z-overlay');
    const panel = sheet();
    expect(classesOf(panel)).toEqual(
      expect.arrayContaining(['bg-overlay', 'pb-safe-bottom', 'rounded-t-md', 'shadow-2']),
    );
  });

  it('grows select options and menu items to the comfortable row', async () => {
    const user = userEvent.setup();
    render(<Region />);
    await user.click(screen.getByRole('button', { name: /Region/ }));
    // The rows size from the sheet around them; the browser specs measure the height.
    for (const option of screen.getAllByRole('option')) {
      expect(isSheet(option)).toBe(true);
      expect(classesOf(option)).toContain('in-data-sheet:min-h-row-comfortable');
    }
    cleanup();
    render(<Actions />);
    await user.click(screen.getByRole('button', { name: 'Payments API' }));
    for (const item of screen.getAllByRole('menuitem')) {
      expect(isSheet(item)).toBe(true);
      expect(classesOf(item)).toContain('in-data-sheet:min-h-row-comfortable');
    }
  });

  it('keeps compact rows in the anchored list', async () => {
    atWidth(1024);
    render(<Region />);
    await userEvent.setup().click(screen.getByRole('button', { name: /Region/ }));
    for (const option of screen.getAllByRole('option')) {
      expect(isSheet(option)).toBe(false);
      expect(classesOf(option)).toContain('min-h-row-compact');
    }
  });

  it('moves focus into the sheet and reads every disabled reason', async () => {
    const user = userEvent.setup();
    render(<Region />);
    await user.click(screen.getByRole('button', { name: /Region/ }));
    expect(sheet().contains(document.activeElement)).toBe(true);
    const option = screen.getByRole('option', { name: /Asia Pacific/ });
    expect(option.getAttribute('aria-disabled')).toBe('true');
    expect(option).toHaveProperty('textContent', expect.stringContaining('Not on your plan'));
    cleanup();
    render(<Actions />);
    await user.click(screen.getByRole('button', { name: 'Payments API' }));
    const item = screen.getByRole('menuitem', { name: /Hide from audience/ });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    const described = (item.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(described).toContain('Only an owner can hide a component');
  });

  it('chooses an option from the sheet, closes it and returns focus to the trigger', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Region onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: /Region/ });
    await user.click(trigger);
    await user.click(screen.getByRole('option', { name: 'United States' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onChange.mock.calls).toEqual([['us']]);
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<Actions />);
    const trigger = screen.getByRole('button', { name: 'Payments API' });
    await user.click(trigger);
    expect(sheet()).toBeDefined();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on a press on the scrim', async () => {
    const user = userEvent.setup();
    render(<Actions />);
    await user.click(screen.getByRole('button', { name: 'Payments API' }));
    const overlay = document.querySelector<HTMLElement>('[data-sheet]');
    if (overlay === null) throw new Error('no sheet');
    await user.click(overlay);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on its Close button', async () => {
    const user = userEvent.setup();
    render(<Actions />);
    await user.click(screen.getByRole('button', { name: 'Payments API' }));
    await user.click(within(sheet()).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('titles a menu by its label, then its trigger label, then the trigger text', async () => {
    const user = userEvent.setup();
    render(
      <Menu trigger="Payments API" label="Actions for Payments API">
        <MenuItem id="open">Open monitor</MenuItem>
      </Menu>,
    );
    await user.click(screen.getByRole('button', { name: 'Payments API' }));
    expect(within(sheet()).getByRole('heading').textContent).toBe('Actions for Payments API');
    cleanup();
    render(
      <Menu trigger="..." triggerLabel="Actions for Checkout">
        <MenuItem id="open">Open monitor</MenuItem>
      </Menu>,
    );
    await user.click(screen.getByRole('button', { name: 'Actions for Checkout' }));
    expect(within(sheet()).getByRole('heading').textContent).toBe('Actions for Checkout');
    cleanup();
    render(<Actions />);
    await user.click(screen.getByRole('button', { name: 'Payments API' }));
    expect(within(sheet()).getByRole('heading').textContent).toBe('Payments API');
  });

  it('runs a menu action from the sheet but never a disabled one', async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(<Actions onAction={onAction} />);
    await user.click(screen.getByRole('button', { name: 'Payments API' }));
    await user.click(screen.getByRole('menuitem', { name: /Hide from audience/ }));
    expect(onAction).not.toHaveBeenCalled();
    await user.click(screen.getByRole('menuitem', { name: 'Copy ID' }));
    expect(onAction.mock.calls).toEqual([['copy']]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens a popover in a sheet titled by its title, with its content inside', async () => {
    const user = userEvent.setup();
    render(
      <Popover trigger="Filters" title="Filter components">
        <Switch>Show uptime figure</Switch>
      </Popover>,
    );
    const trigger = screen.getByRole('button', { name: 'Filters' });
    await user.click(trigger);
    const panel = sheet();
    expect(isSheet(panel)).toBe(true);
    expect(
      within(panel)
        .getAllByRole('heading')
        .map((h) => h.textContent),
    ).toEqual(['Filter components']);
    expect(within(panel).getByRole('switch', { name: 'Show uptime figure' })).toBeDefined();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('titles an untitled popover by its trigger', async () => {
    const user = userEvent.setup();
    render(
      <Popover trigger="Filters">
        <p>Nothing to filter yet.</p>
      </Popover>,
    );
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    expect(within(sheet()).getByRole('heading').textContent).toBe('Filters');
  });

  it('keeps Tab inside a popover sheet instead of closing it', async () => {
    const user = userEvent.setup();
    render(
      <Popover trigger="Filters" title="Filter components">
        <Switch>Show uptime figure</Switch>
      </Popover>,
    );
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    for (let i = 0; i < 4; i += 1) {
      await user.tab();
      expect(sheet().contains(document.activeElement)).toBe(true);
    }
  });

  it('opens a second sheet over a dialog and Escape closes only the sheet', async () => {
    const user = userEvent.setup();
    render(
      <Dialog trigger="Invite" title="Invite people">
        <Region />
      </Dialog>,
    );
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    const region = screen.getByRole('button', { name: /Region/ });
    await user.click(region);
    const dialogs = screen.getAllByRole('dialog');
    expect(dialogs.map((d) => d.getAttribute('aria-labelledby') !== null)).toEqual([true, true]);
    const picker = screen.getByRole('heading', { name: 'Region' }).closest('[role="dialog"]');
    expect(picker?.closest('[data-sheet]')).not.toBeNull();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Invite people' })).toBeDefined();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(region);
  });

  it('a press on the sheet scrim over a dialog closes only the sheet', async () => {
    const user = userEvent.setup();
    render(
      <Dialog trigger="Invite" title="Invite people">
        <Region />
      </Dialog>,
    );
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    await user.click(screen.getByRole('button', { name: /Region/ }));
    const overlay = document.querySelector<HTMLElement>('[data-sheet]');
    if (overlay === null) throw new Error('no sheet');
    await user.click(overlay);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Invite people' })).toBeDefined();
  });
});
