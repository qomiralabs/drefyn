import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { Dialog, MultiCombobox, SelectOption } from '../../src/react/index.ts';
import { classesOf } from './classes.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Props = Partial<ComponentProps<typeof MultiCombobox>>;

function Projects(props: Props) {
  return (
    <MultiCombobox label="Projects" tagsLabel="Projects this key can reach" {...props}>
      <SelectOption value="pay" description="Docs">
        Payments API docs
      </SelectOption>
      <SelectOption value="partner" description="Docs">
        Partner API docs
      </SelectOption>
      <SelectOption value="status">Status page</SelectOption>
      <SelectOption value="old" disabled description="Archived">
        Old site
      </SelectOption>
    </MultiCombobox>
  );
}

const input = () => screen.getByRole<HTMLInputElement>('combobox', { name: 'Projects' });
const listbox = () => screen.getByRole('listbox');
const option = (name: string | RegExp) => screen.getByRole('option', { name });
const chips = () => screen.queryAllByRole('row').map((row) => row.getAttribute('aria-label'));
const describedBy = (el: HTMLElement) =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');

// usePhone reads the small breakpoint from matchMedia; happy-dom answers false to it.
function asPhone() {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

describe('MultiCombobox', () => {
  it('starts closed on a combobox named by its label, showing its chosen chips', () => {
    render(<Projects defaultValue={['pay']} />);
    expect(input().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(chips()).toEqual(['Payments API docs']);
  });

  it('opens every option on a click, in a list that says it takes several', async () => {
    render(<Projects />);
    await userEvent.setup().click(input());
    expect(input().getAttribute('aria-expanded')).toBe('true');
    expect(listbox().getAttribute('aria-multiselectable')).toBe('true');
    expect(within(listbox()).getAllByRole('option')).toHaveLength(4);
  });

  it('filters as the person types', async () => {
    const user = userEvent.setup();
    render(<Projects />);
    await user.type(input(), 'docs');
    expect(
      within(listbox())
        .getAllByRole('option')
        .map((o) => o.getAttribute('aria-labelledby') !== null),
    ).toHaveLength(2);
    expect(screen.queryByRole('option', { name: /Status page/ })).toBeNull();
  });

  it('adds a pick as a chip, stays open and keeps the search for the next pick', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Projects onChange={onChange} />);
    await user.type(input(), 'docs');
    await user.click(option(/Payments/));
    expect(listbox()).toBeDefined();
    expect(input().value).toBe('docs');
    await user.click(option(/Partner/));
    expect(chips()).toEqual(['Payments API docs', 'Partner API docs']);
    expect(onChange.mock.calls).toEqual([[['pay']], [['pay', 'partner']]]);
  });

  it('marks a chosen option with a tick and takes it off when picked again', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Projects defaultValue={['pay']} onChange={onChange} />);
    await user.click(input());
    const chosen = option(/Payments/);
    expect(chosen.getAttribute('aria-selected')).toBe('true');
    expect(chosen.querySelector('[data-icon="check"]')).not.toBeNull();
    await user.click(chosen);
    expect(chips()).toEqual([]);
    expect(onChange.mock.calls).toEqual([[[]]]);
  });

  it('removes a chip by its button', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Projects defaultValue={['pay', 'status']} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /^Remove Payments/ }));
    expect(chips()).toEqual(['Status page']);
    expect(onChange.mock.calls).toEqual([[['status']]]);
  });

  it('moves to the last chip on Backspace in an empty input, and a second press removes it', async () => {
    const user = userEvent.setup();
    render(<Projects defaultValue={['pay', 'status']} />);
    await user.click(input());
    await user.keyboard('{Escape}{Backspace}');
    expect(document.activeElement).toBe(screen.getByRole('row', { name: 'Status page' }));
    await user.keyboard('{Backspace}');
    expect(chips()).toEqual(['Payments API docs']);
  });

  it('clears the search when the list closes', async () => {
    const user = userEvent.setup();
    render(<Projects />);
    await user.type(input(), 'docs{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input().value).toBe('');
  });

  it('says so when nothing matches, and keeps the list open', async () => {
    const user = userEvent.setup();
    render(<Projects emptyText="No projects match" />);
    await user.type(input(), 'zzz');
    expect(within(listbox()).getByText('No projects match')).toBeDefined();
  });

  it('shows an empty list as empty', async () => {
    const user = userEvent.setup();
    render(
      <MultiCombobox label="Projects" emptyText="No projects yet">
        {[]}
      </MultiCombobox>,
    );
    await user.click(input());
    expect(within(listbox()).getByText('No projects yet')).toBeDefined();
  });

  it('counts the matches under a search when asked', async () => {
    const user = userEvent.setup();
    render(
      <Projects
        countLabel={(matches, total, query) => `${matches} of ${total} projects match ${query}`}
      />,
    );
    await user.click(input());
    expect(screen.queryByText(/projects match/)).toBeNull();
    await user.keyboard('docs');
    expect(screen.getByText('2 of 4 projects match docs')).toBeDefined();
  });

  it('shows skeleton rows and marks the list busy while loading', async () => {
    render(
      <MultiCombobox label="Projects" loading>
        {[]}
      </MultiCombobox>,
    );
    await userEvent.setup().click(input());
    expect(listbox().getAttribute('aria-busy')).toBe('true');
    expect(listbox().querySelectorAll('[data-skeleton]').length).toBe(3);
    expect(
      within(listbox())
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Loading options']);
  });

  it('holds a chip whose option is still loading as a skeleton, not a raw id', () => {
    render(
      <MultiCombobox label="Projects" loading defaultValue={['proj_123']}>
        {[]}
      </MultiCombobox>,
    );
    const row = screen.getByRole('row');
    expect(row.textContent).not.toContain('proj_123');
    expect(row.querySelector('[data-skeleton]')).not.toBeNull();
    expect(row.getAttribute('aria-label')).toBe('Loading');
  });

  it('falls back to the value for a chip with no option left', () => {
    render(<Projects defaultValue={['gone']} />);
    expect(chips()).toEqual(['gone']);
  });

  it('follows its value prop when controlled', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<Projects value={['pay']} onChange={onChange} />);
    await user.click(input());
    await user.click(option(/Status/));
    expect(onChange.mock.calls).toEqual([[['pay', 'status']]]);
    expect(chips()).toEqual(['Payments API docs']);
    rerender(<Projects value={['pay', 'status']} onChange={onChange} />);
    expect(chips()).toEqual(['Payments API docs', 'Status page']);
  });

  it('never reports a change when it closes with the same picks', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Projects value={['pay']} onChange={onChange} />);
    await user.click(input());
    await user.keyboard('{Escape}');
    await user.tab();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('posts one value per chip under its name', () => {
    render(
      <form aria-label="Key">
        <Projects name="projects" defaultValue={['pay', 'status']} />
      </form>,
    );
    const form = screen.getByRole<HTMLFormElement>('form', { name: 'Key' });
    expect(new FormData(form).getAll('projects')).toEqual(['pay', 'status']);
  });

  it('joins its description and error to the input and marks itself invalid', () => {
    render(<Projects description="Only these projects." error="Choose at least one project." />);
    expect(describedBy(input())).toContain('Only these projects.');
    expect(describedBy(input())).toContain('Choose at least one project.');
    expect(input().getAttribute('aria-invalid')).toBe('true');
  });

  it('keeps its chips exposed to readers only while its list is open', async () => {
    const user = userEvent.setup();
    render(<Projects defaultValue={['pay']} />);
    const exempt = () => document.querySelector('[data-react-aria-top-layer]');
    expect(exempt()).toBeNull();
    await user.click(input());
    expect(exempt()?.contains(screen.getByRole('row'))).toBe(true);
    await user.keyboard('{Escape}');
    expect(exempt()).toBeNull();
  });

  it('never chooses a disabled option', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Projects onChange={onChange} />);
    await user.click(input());
    const old = option(/Old site/);
    expect(old.getAttribute('aria-disabled')).toBe('true');
    await user.click(old);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('closes on Escape and leaves a dialog around it open', async () => {
    const user = userEvent.setup();
    render(
      <Dialog trigger="Create key" title="Create key" defaultOpen>
        <Projects defaultValue={['pay']} />
      </Dialog>,
    );
    await user.click(input());
    expect(listbox()).toBeDefined();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Create key' })).toBeDefined();
  });

  it('needs a visible label', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<MultiCombobox label="">{[]}</MultiCombobox>)).toThrow(/label/);
  });

  it('uses DOM names and never the React Aria ones', () => {
    // @ts-expect-error disabled, not isDisabled.
    const a = <MultiCombobox label="Projects" isDisabled />;
    // @ts-expect-error value, not selectedKeys.
    const b = <MultiCombobox label="Projects" selectedKeys={[]} />;
    expect([a, b]).toHaveLength(2);
  });
});

describe('a disabled MultiCombobox', () => {
  it('stays focusable with aria-disabled, never opens and never changes', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Projects disabled defaultValue={['pay']} onChange={onChange} />);
    expect(input().getAttribute('aria-disabled')).toBe('true');
    expect(input().disabled).toBe(false);
    await user.click(input());
    expect(document.activeElement).toBe(input());
    await user.keyboard('{ArrowDown}docs{Backspace}');
    fireEvent.keyDown(input(), { key: 'Backspace' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(chips()).toEqual(['Payments API docs']);
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps Backspace from reaching the browser, which can go back a page', () => {
    render(<Projects disabled />);
    expect(fireEvent.keyDown(input(), { key: 'Backspace' })).toBe(false);
  });

  it('paints the box with the disabled family', () => {
    render(<Projects disabled />);
    expect(classesOf(screen.getByRole('group', { name: 'Projects' }))).toEqual(
      expect.arrayContaining(['border-disabled-edge', 'bg-disabled-fill']),
    );
  });
});

describe('on a phone', () => {
  const trigger = () => screen.getByRole('button', { name: /^Projects/ });

  it('offers a button instead of the input, so the keyboard waits for the sheet', () => {
    asPhone();
    render(<Projects placeholder="Search projects" />);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(trigger().textContent).toContain('Search projects');
    expect(trigger().getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('opens a sheet titled by the label, with the search and a list that takes several', async () => {
    asPhone();
    const user = userEvent.setup();
    render(<Projects placeholder="Search projects" />);
    await user.click(trigger());
    const sheet = screen.getByRole('dialog', { name: 'Projects' });
    expect(within(sheet).getByRole('heading', { name: 'Projects' })).toBeDefined();
    expect(within(sheet).getByRole('listbox').getAttribute('aria-multiselectable')).toBe('true');
    expect(within(sheet).getAllByRole('option')).toHaveLength(4);
  });

  it('adds picks from the sheet, stays open and shows the chips after it closes', async () => {
    asPhone();
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Projects onChange={onChange} />);
    await user.click(trigger());
    await user.click(option(/Payments/));
    await user.click(option(/Status/));
    expect(listbox()).toBeDefined();
    expect(onChange.mock.calls).toEqual([[['pay']], [['pay', 'status']]]);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(chips()).toEqual(['Payments API docs', 'Status page']);
  });

  it('filters in the sheet and clears the search when it closes', async () => {
    asPhone();
    const user = userEvent.setup();
    render(<Projects />);
    await user.click(trigger());
    await user.type(screen.getByRole('textbox', { name: 'Search' }), 'status');
    expect(within(listbox()).getAllByRole('option')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(trigger());
    expect(within(listbox()).getAllByRole('option')).toHaveLength(4);
  });

  it('posts its chips with the sheet closed', () => {
    asPhone();
    render(
      <form aria-label="Key">
        <Projects name="projects" defaultValue={['pay']} />
      </form>,
    );
    const form = screen.getByRole<HTMLFormElement>('form', { name: 'Key' });
    expect(new FormData(form).getAll('projects')).toEqual(['pay']);
  });

  it('never opens while disabled', async () => {
    asPhone();
    render(<Projects disabled />);
    expect(trigger().getAttribute('aria-disabled')).toBe('true');
    await userEvent.setup().click(trigger());
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
