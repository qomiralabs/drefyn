import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState, type ComponentProps } from 'react';
import { CommandBar } from '../../src/react/index.ts';

afterEach(cleanup);

type Props = ComponentProps<typeof CommandBar>;

const ITEMS: Props['items'] = [
  { id: 'status', label: 'Open Status', context: 'status.acme.com', group: 'Go to' },
  { id: 'docs', label: 'Open Docs', context: 'Payments API docs', group: 'Go to' },
  { id: 'incident', label: 'Start an incident', group: 'Actions', shortcut: 'I' },
  {
    id: 'delete',
    label: 'Delete the project',
    group: 'Actions',
    disabled: true,
    reason: 'Only an owner can delete a project',
  },
];

function Bar(props: Partial<Props>) {
  const [open, setOpen] = useState(true);
  return (
    <CommandBar
      items={ITEMS}
      onAction={() => undefined}
      {...props}
      open={props.open ?? open}
      onOpenChange={(next) => {
        setOpen(next);
        props.onOpenChange?.(next);
      }}
    />
  );
}

const field = () => screen.getByRole('combobox', { name: 'Search or run a command' });
const rows = () => within(screen.getByRole('listbox')).queryAllByRole('option');
// The label alone, without the context after it; the no results line is not a row.
const names = () =>
  rows().flatMap((r) => {
    const label = r.querySelector('[data-label]');
    return label === null ? [] : [label.textContent];
  });

describe('CommandBar', () => {
  it('renders nothing while closed', () => {
    render(<Bar open={false} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens a dialog named by its label with focus in the search field', () => {
    render(<Bar />);
    expect(screen.getByRole('dialog', { name: 'Search or run a command' })).toBeDefined();
    expect(document.activeElement).toBe(field());
    expect(field().getAttribute('aria-expanded')).toBe('true');
    expect(field().getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id);
  });

  it('lists every row under its group word', () => {
    render(<Bar />);
    expect(names()).toEqual([
      'Open Status',
      'Open Docs',
      'Start an incident',
      'Delete the project',
    ]);
    const groups = within(screen.getByRole('listbox')).getAllByRole('group');
    expect(groups.map((g) => g.getAttribute('aria-labelledby') !== null)).toEqual([true, true]);
    expect(
      groups.map(
        (g) => document.getElementById(g.getAttribute('aria-labelledby') ?? '')?.textContent,
      ),
    ).toEqual(['Go to', 'Actions']);
  });

  it('filters as the person types and drops a group with no rows left', async () => {
    const user = userEvent.setup();
    render(<Bar />);
    await user.type(field(), 'stat');
    expect(names()).toEqual(['Open Status']);
    expect(within(screen.getByRole('listbox')).getAllByRole('group')).toHaveLength(1);
  });

  it('matches the context and the group word, ignoring case', async () => {
    const user = userEvent.setup();
    render(<Bar />);
    await user.type(field(), 'PAYMENTS');
    expect(names()).toEqual(['Open Docs']);
    await user.clear(field());
    await user.type(field(), 'actions');
    expect(names()).toEqual(['Start an incident', 'Delete the project']);
  });

  it('runs a row, then closes', async () => {
    const onAction = vi.fn();
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<Bar onAction={onAction} onOpenChange={onOpenChange} />);
    await user.click(screen.getByRole('option', { name: /Open Docs/ }));
    expect(onAction.mock.calls).toEqual([['docs']]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps a disabled row with its reason and never runs it', async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(<Bar onAction={onAction} />);
    const row = screen.getByRole('option', { name: /Delete the project/ });
    expect(row.getAttribute('aria-disabled')).toBe('true');
    const described = (row.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(described).toContain('Only an owner can delete a project');
    await user.click(row);
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('shows a shortcut as a keycap and names it with aria-keyshortcuts', () => {
    render(<Bar />);
    const row = screen.getByRole('option', { name: /Start an incident/ });
    expect(row.getAttribute('aria-keyshortcuts')).toBe('I');
    expect(row.querySelector('kbd')?.textContent).toBe('I');
  });

  it('says plainly when nothing matches, in the list and to screen readers', async () => {
    const user = userEvent.setup();
    render(<Bar />);
    expect(screen.getByRole('status').textContent).toBe('');
    await user.type(field(), 'zebra');
    expect(names()).toEqual([]);
    expect(screen.getByRole('listbox').textContent).toContain('Nothing matches “zebra”.');
    expect(screen.getByRole('status').textContent).toBe('No results for “zebra”');
    expect(within(screen.getByRole('listbox')).queryAllByRole('button')).toHaveLength(0);
    expect(within(screen.getByRole('listbox')).queryAllByRole('link')).toHaveLength(0);
  });

  it('loading keeps the field and draws skeleton rows in a busy list', () => {
    render(<Bar items={[]} loading />);
    expect(field()).toBeDefined();
    const list = screen.getByRole('listbox');
    expect(list.getAttribute('aria-busy')).toBe('true');
    expect(list.querySelectorAll('[data-skeleton]').length).toBeGreaterThan(0);
    expect(within(list).getByText('Loading results')).toBeDefined();
  });

  it('a failed search shows the reason and a Retry row that retries, not runs', async () => {
    const onRetry = vi.fn();
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(
      <Bar items={[]} error="Search is not answering." onRetry={onRetry} onAction={onAction} />,
    );
    expect(screen.getByRole('alert').textContent).toContain('Search is not answering.');
    await user.type(field(), 'stat');
    const retry = screen.getByRole('option', { name: /Retry/ });
    await user.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('Escape clears the query first, then closes', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<Bar onOpenChange={onOpenChange} />);
    await user.type(field(), 'stat');
    await user.keyboard('{Escape}');
    expect((field() as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('dialog')).toBeDefined();
    await user.keyboard('{Escape}');
    expect(onOpenChange.mock.calls).toEqual([[false]]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('starts from an empty query each time it opens', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Bar open />);
    await user.type(field(), 'stat');
    rerender(<Bar open={false} />);
    rerender(<Bar open />);
    expect((field() as HTMLInputElement).value).toBe('');
  });

  it('reports the query to a caller that searches elsewhere', async () => {
    const onQueryChange = vi.fn();
    const user = userEvent.setup();
    render(<Bar onQueryChange={onQueryChange} />);
    await user.type(field(), 'ab');
    expect(onQueryChange.mock.calls).toEqual([['a'], ['ab']]);
  });

  it('names the scope it searches and offers Cancel for touch', () => {
    render(<Bar scope="In Acme" />);
    expect(screen.getByText('In Acme')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDefined();
  });

  it('Cancel closes', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<Bar onOpenChange={onOpenChange} />);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange.mock.calls).toEqual([[false]]);
  });

  it('hides the browser search cancel button, since it draws its own clear button', () => {
    render(<Bar />);
    expect(field().hasAttribute('data-command-field')).toBe(true);
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'react', 'react.css'),
      'utf8',
    );
    expect(css).toMatch(
      /\[data-command-field\]::-webkit-search-cancel-button\s*\{[^}]*display: none;/,
    );
  });
});
