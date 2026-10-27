import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Button,
  IconMore,
  Menu,
  MenuItem,
  MenuSection,
  MenuSeparator,
} from '../../src/react/index.ts';
import { classesOf } from './classes.ts';

afterEach(cleanup);

interface Handlers {
  onAction?: (id: string) => void;
  onOpen?: () => void;
  onHide?: () => void;
}

const noop = (): void => undefined;

function Actions({ onAction = noop, onOpen = noop, onHide = noop }: Handlers) {
  return (
    <Menu trigger="Payments API" onAction={onAction}>
      <MenuItem id="open" shortcut="O" onAction={onOpen}>
        Open monitor
      </MenuItem>
      <MenuItem id="incident">Start incident</MenuItem>
      <MenuItem id="hide" disabled onAction={onHide}>
        Hide from audience
      </MenuItem>
      <MenuItem id="copy">Copy ID</MenuItem>
    </Menu>
  );
}

const trigger = () => screen.getByRole('button', { name: 'Payments API' });

describe('Menu', () => {
  it('starts closed behind a trigger that says it opens a menu', () => {
    render(<Actions />);
    const el = trigger();
    expect(el.getAttribute('aria-haspopup')).toMatch(/^(true|menu)$/);
    expect(el.getAttribute('aria-expanded')).not.toBe('true');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('styles its trigger with the same class function as Button', () => {
    render(
      <>
        <Actions />
        <Button variant="secondary">Plain</Button>
      </>,
    );
    const plain = classesOf(screen.getByRole('button', { name: 'Plain' }));
    expect(plain.length).toBeGreaterThan(0);
    expect(classesOf(trigger())).toEqual(expect.arrayContaining(plain));
  });

  it('opens on a click into a menu named by its trigger, with every item', async () => {
    render(<Actions />);
    await userEvent.setup().click(trigger());
    const menu = screen.getByRole('menu', { name: 'Payments API' });
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining('Open monitor'),
      'Start incident',
      'Hide from audience',
      'Copy ID',
    ]);
  });

  it('keeps the shortcut out of the item name and shows it as a key', async () => {
    render(<Actions />);
    await userEvent.setup().click(trigger());
    const item = screen.getByRole('menuitem', { name: 'Open monitor' });
    expect(item.querySelector('kbd')?.textContent).toBe('O');
  });

  it('runs the item and the menu handler, then closes', async () => {
    const onAction = vi.fn();
    const onOpen = vi.fn();
    render(<Actions onAction={onAction} onOpen={onOpen} />);
    const user = userEvent.setup();
    await user.click(trigger());
    await user.click(screen.getByRole('menuitem', { name: 'Open monitor' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith('open');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('marks a disabled item unavailable, ignores it and stays open', async () => {
    const onAction = vi.fn();
    const onHide = vi.fn();
    render(<Actions onAction={onAction} onHide={onHide} />);
    const user = userEvent.setup();
    await user.click(trigger());
    const item = screen.getByRole('menuitem', { name: 'Hide from audience' });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    await user.click(item);
    expect(onHide).not.toHaveBeenCalled();
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeDefined();
  });

  it('paints a disabled item with disabled text and never the hover fill', async () => {
    render(<Actions />);
    await userEvent.setup().click(trigger());
    const classes = classesOf(screen.getByRole('menuitem', { name: 'Hide from audience' }));
    expect(classes).toContain('text-disabled-text');
    expect(classes.filter((c) => /bg-(hover|pressed)$/.test(c))).toEqual([]);
    expect(classes.filter((c) => /(^|:)opacity-/.test(c))).toEqual([]);
  });

  it('draws items flush, with the inset ring and the hover and pressed fills', async () => {
    render(<Actions />);
    await userEvent.setup().click(trigger());
    const classes = classesOf(screen.getByRole('menuitem', { name: 'Start incident' }));
    expect(classes).toEqual(expect.arrayContaining(['min-h-row-compact']));
    expect(classes.some((c) => c.endsWith(':focus-ring-inset'))).toBe(true);
    expect(classes.some((c) => c.endsWith(':bg-hover'))).toBe(true);
    expect(classes.some((c) => c.endsWith(':bg-pressed'))).toBe(true);
    expect(classes.filter((c) => c.endsWith(':focus-ring'))).toEqual([]);
  });

  it('floats on the overlay surface with the strong rule and the small shadow', async () => {
    render(<Actions />);
    await userEvent.setup().click(trigger());
    let el: HTMLElement | null = screen.getByRole('menu');
    const seen: string[] = [];
    while (el !== null && el !== document.body) {
      seen.push(...classesOf(el));
      el = el.parentElement;
    }
    expect(seen).toEqual(
      expect.arrayContaining(['bg-overlay', 'border-rule-strong', 'shadow-1', 'z-overlay']),
    );
    expect(seen.filter((c) => /(^|:)bg-(raised|sunken)$/.test(c))).toEqual([]);
  });

  it('groups items under a labelled section and separates groups', async () => {
    render(
      <Menu trigger="View">
        <MenuSection title="Show">
          <MenuItem id="uptime">Uptime figure</MenuItem>
          <MenuItem id="latency">Latency</MenuItem>
        </MenuSection>
        <MenuSeparator />
        <MenuItem id="reset">Reset view</MenuItem>
      </Menu>,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'View' }));
    const group = screen.getByRole('group', { name: 'Show' });
    expect(within(group).getAllByRole('menuitem')).toHaveLength(2);
    expect(screen.getByRole('separator')).toBeDefined();
  });

  it('names an icon only trigger from its label', () => {
    render(
      <Menu trigger={<IconMore />} triggerLabel="Actions for Checkout" variant="quiet" size="sm">
        <MenuItem id="open">Open monitor</MenuItem>
      </Menu>,
    );
    const el = screen.getByRole('button', { name: 'Actions for Checkout' });
    expect(el.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('uses DOM names and React Aria names only where the DOM has none, never is* or onPress', () => {
    // @ts-expect-error disabled, not isDisabled.
    const a = <MenuItem id="x" isDisabled children="Open monitor" />;
    // @ts-expect-error onAction, not onPress.
    const b = <MenuItem id="x" onPress={() => undefined} children="Open monitor" />;
    const item = <MenuItem id="x">Open monitor</MenuItem>;
    // @ts-expect-error defaultOpen, not isOpen.
    const c = <Menu trigger="More" isOpen children={item} />;
    expect([a, b, c]).toHaveLength(3);
  });

  it('can start open, for a story or a test of the open state', () => {
    render(
      <Menu trigger="Payments API" defaultOpen>
        <MenuItem id="open">Open monitor</MenuItem>
      </Menu>,
    );
    expect(screen.getByRole('menu', { name: 'Payments API' })).toBeDefined();
  });

  it('takes its own name when the trigger text would not describe it', async () => {
    render(
      <Menu trigger="More" label="Actions for Payments API">
        <MenuItem id="open">Open monitor</MenuItem>
      </Menu>,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('menu', { name: 'Actions for Payments API' })).toBeDefined();
  });
});
