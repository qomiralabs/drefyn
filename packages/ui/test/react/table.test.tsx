import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { EmptyState, Table } from '../../src/react/index.ts';
import { classesOf } from './classes.ts';

afterEach(cleanup);

interface Page {
  id: string;
  title: string;
  views: number;
}

const PAGES: Page[] = [
  { id: 'refunds', title: 'Refunds', views: 120 },
  { id: 'payouts', title: 'Create a payout', views: 4_800 },
  { id: 'keys', title: 'API keys', views: 960 },
];

const COLUMNS: ComponentProps<typeof Table<Page>>['columns'] = [
  { id: 'title', label: 'Page', rowHeader: true, cell: (p) => p.title, sortValue: (p) => p.title },
  {
    id: 'views',
    label: 'Views',
    numeric: true,
    cell: (p) => p.views.toLocaleString('en-GB'),
    sortValue: (p) => p.views,
  },
  { id: 'owner', label: 'Owner', cell: () => 'Maya Okafor' },
];

type Props = Partial<ComponentProps<typeof Table<Page>>>;

function Pages(props: Props) {
  return (
    <Table<Page>
      label="Pages"
      columns={COLUMNS}
      rows={PAGES}
      empty={
        <EmptyState title="No pages yet" headingLevel={3}>
          Pages appear here once the first one is published.
        </EmptyState>
      }
      {...props}
    />
  );
}

const grid = () => screen.getByRole('grid', { name: 'Pages' });
// Data rows only: the header row holds column headers.
const dataRows = () =>
  within(grid())
    .getAllByRole('row')
    .filter((r) => within(r).queryAllByRole('columnheader').length === 0);
const titles = () => dataRows().map((r) => within(r).getByRole('rowheader').textContent);
const header = (name: string) => screen.getByRole('columnheader', { name: new RegExp(name) });

describe('Table', () => {
  it('is a grid named by its label, with column headers and a row header per row', () => {
    render(<Pages />);
    expect(grid()).toBeDefined();
    expect(
      within(grid())
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Page', 'Views', 'Owner']);
    expect(titles()).toEqual(['Refunds', 'Create a payout', 'API keys']);
  });

  it('refuses an empty label', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Pages label=" " />)).toThrow(/label/);
  });

  it('marks sortable headers with aria-sort and leaves others without it', () => {
    render(<Pages />);
    expect(header('Page').getAttribute('aria-sort')).toBe('none');
    expect(header('Views').getAttribute('aria-sort')).toBe('none');
    expect(header('Owner').hasAttribute('aria-sort')).toBe(false);
  });

  it('sorts ascending, then descending, on presses of a header and reports each', async () => {
    const onSortChange = vi.fn();
    const user = userEvent.setup();
    render(<Pages onSortChange={onSortChange} />);
    await user.click(header('Views'));
    expect(header('Views').getAttribute('aria-sort')).toBe('ascending');
    expect(titles()).toEqual(['Refunds', 'API keys', 'Create a payout']);
    await user.click(header('Views'));
    expect(header('Views').getAttribute('aria-sort')).toBe('descending');
    expect(titles()).toEqual(['Create a payout', 'API keys', 'Refunds']);
    expect(onSortChange.mock.calls).toEqual([
      [{ column: 'views', direction: 'ascending' }],
      [{ column: 'views', direction: 'descending' }],
    ]);
  });

  it('starts from a default sort', () => {
    render(<Pages defaultSort={{ column: 'title', direction: 'ascending' }} />);
    expect(header('Page').getAttribute('aria-sort')).toBe('ascending');
    expect(titles()).toEqual(['API keys', 'Create a payout', 'Refunds']);
  });

  it('follows a held sort and only reports a press', async () => {
    const onSortChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Pages sort={{ column: 'views', direction: 'descending' }} onSortChange={onSortChange} />,
    );
    expect(titles()).toEqual(['Create a payout', 'API keys', 'Refunds']);
    await user.click(header('Page'));
    expect(onSortChange.mock.calls).toEqual([[{ column: 'title', direction: 'ascending' }]]);
    expect(titles()).toEqual(['Create a payout', 'API keys', 'Refunds']);
  });

  it('draws the sort direction as an icon beside the header word', async () => {
    const user = userEvent.setup();
    render(<Pages />);
    await user.click(header('Views'));
    expect(header('Views').querySelector('[data-icon]')).not.toBeNull();
    expect(header('Owner').querySelector('[data-icon]')).toBeNull();
  });

  it('sets number columns end aligned in tabular figures', () => {
    render(<Pages />);
    const cell = within(dataRows()[1] as HTMLElement).getAllByRole('gridcell')[0] as HTMLElement;
    expect(cell.textContent).toBe('4,800');
    expect(classesOf(cell)).toEqual(expect.arrayContaining(['tabular-nums', 'text-end']));
  });

  it('uses compact rows by default and comfortable rows when asked', () => {
    render(<Pages />);
    expect(classesOf(dataRows()[0] as HTMLElement)).toContain('h-row-compact');
    cleanup();
    render(<Pages density="comfortable" />);
    expect(classesOf(dataRows()[0] as HTMLElement)).toContain('h-row-comfortable');
  });

  it('runs a row action on a press and on Enter', async () => {
    const onRowAction = vi.fn();
    const user = userEvent.setup();
    render(<Pages onRowAction={onRowAction} />);
    await user.click(within(dataRows()[0] as HTMLElement).getByRole('rowheader'));
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onRowAction.mock.calls).toEqual([['refunds'], ['payouts']]);
  });

  describe('with selection', () => {
    const box = (row: HTMLElement) => within(row).getByRole('checkbox');

    it('gives each row a checkbox named by the row and a select all box', () => {
      render(<Pages selectable />);
      expect(box(dataRows()[0] as HTMLElement)).toBeDefined();
      expect(screen.getByRole('checkbox', { name: 'Select all' })).toBeDefined();
    });

    it('selects rows, marks them selected and reports the ids', async () => {
      const onSelectionChange = vi.fn();
      const user = userEvent.setup();
      render(<Pages selectable onSelectionChange={onSelectionChange} />);
      await user.click(box(dataRows()[1] as HTMLElement));
      expect(dataRows()[1]?.getAttribute('aria-selected')).toBe('true');
      expect(onSelectionChange.mock.calls.at(-1)).toEqual([['payouts']]);
      expect(screen.getByRole('status').textContent).toBe('1 selected');
    });

    it('select all picks every row but a disabled one', async () => {
      const onSelectionChange = vi.fn();
      const user = userEvent.setup();
      render(
        <Pages
          selectable
          disabledRows={{ keys: 'Keys pages are managed by the API' }}
          onSelectionChange={onSelectionChange}
        />,
      );
      await user.click(screen.getByRole('checkbox', { name: 'Select all' }));
      expect(onSelectionChange.mock.calls.at(-1)?.[0]).toEqual(['refunds', 'payouts']);
      expect(screen.getByRole('status').textContent).toBe('2 selected');
    });

    it('starts from a default selection and follows a held one', () => {
      render(<Pages selectable defaultSelected={['refunds']} />);
      expect(dataRows()[0]?.getAttribute('aria-selected')).toBe('true');
      cleanup();
      render(<Pages selectable selected={['keys']} onSelectionChange={() => undefined} />);
      expect(dataRows()[2]?.getAttribute('aria-selected')).toBe('true');
      expect(dataRows()[0]?.getAttribute('aria-selected')).toBe('false');
    });

    it('selects with Space on a focused row', async () => {
      const onSelectionChange = vi.fn();
      const user = userEvent.setup();
      render(<Pages selectable onSelectionChange={onSelectionChange} />);
      await user.tab();
      await user.keyboard('{ArrowDown}{ArrowDown}{Space}');
      expect(onSelectionChange.mock.calls.at(-1)).toEqual([['payouts']]);
    });
  });

  describe('a disabled row', () => {
    it('stays in the grid, reads its reason and is never selected or run', async () => {
      const onSelectionChange = vi.fn();
      const onRowAction = vi.fn();
      const user = userEvent.setup();
      render(
        <Pages
          selectable
          disabledRows={{ keys: 'Keys pages are managed by the API' }}
          onSelectionChange={onSelectionChange}
          onRowAction={onRowAction}
        />,
      );
      const row = dataRows()[2] as HTMLElement;
      expect(row.getAttribute('aria-disabled')).toBe('true');
      expect(row.textContent).toContain('Keys pages are managed by the API');
      await user.click(within(row).getByRole('rowheader'));
      await user.click(within(row).getByRole('checkbox'));
      expect(onSelectionChange).not.toHaveBeenCalled();
      expect(onRowAction).not.toHaveBeenCalled();
      expect(row.getAttribute('aria-selected')).not.toBe('true');
    });

    it('is reached by the arrow keys', async () => {
      const user = userEvent.setup();
      render(<Pages disabledRows={{ payouts: 'Archived pages cannot be opened' }} />);
      await user.tab();
      await user.keyboard('{ArrowDown}{ArrowDown}');
      expect(document.activeElement).toBe(dataRows()[1]);
    });

    it('paints its words in body text, never with opacity', () => {
      render(<Pages disabledRows={{ keys: 'Keys pages are managed by the API' }} />);
      const row = dataRows()[2] as HTMLElement;
      expect(classesOf(row).some((c) => c.includes('opacity'))).toBe(false);
      expect(classesOf(row)).toContain('text-body');
    });
  });

  describe('states', () => {
    it('loading keeps the header, draws skeleton rows and marks the grid busy', () => {
      render(<Pages rows={[]} loading />);
      expect(grid().getAttribute('aria-busy')).toBe('true');
      expect(within(grid()).getAllByRole('columnheader')).toHaveLength(3);
      expect(grid().querySelectorAll('[data-skeleton]').length).toBeGreaterThan(0);
      expect(within(grid()).getByText('Loading pages')).toBeDefined();
      expect(within(grid()).queryAllByRole('rowheader')).toHaveLength(0);
    });

    it('a refresh keeps the rows and marks the grid busy', () => {
      render(<Pages loading />);
      expect(grid().getAttribute('aria-busy')).toBe('true');
      expect(titles()).toHaveLength(3);
    });

    it('is not busy at rest', () => {
      render(<Pages />);
      expect(grid().hasAttribute('aria-busy')).toBe(false);
    });

    it('empty shows the empty state inside the frame instead of the grid', () => {
      render(<Pages rows={[]} />);
      expect(screen.queryByRole('grid')).toBeNull();
      expect(screen.getByRole('heading', { name: 'No pages yet' })).toBeDefined();
    });

    it('a failed first load shows the error with Retry instead of the grid', async () => {
      const onRetry = vi.fn();
      const user = userEvent.setup();
      render(<Pages rows={[]} error="The pages service did not answer." onRetry={onRetry} />);
      expect(screen.queryByRole('grid')).toBeNull();
      expect(screen.getByRole('heading', { name: 'Could not load pages' })).toBeDefined();
      expect(screen.getByText('The pages service did not answer.')).toBeDefined();
      await user.click(screen.getByRole('button', { name: 'Retry' }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('a failed refresh keeps the rows and says so above them', () => {
      render(
        <Pages error="Could not refresh. Showing pages from 14:02." onRetry={() => undefined} />,
      );
      expect(titles()).toHaveLength(3);
      const notice = screen.getByRole('alert');
      expect(notice.textContent).toContain('Could not refresh. Showing pages from 14:02.');
      expect(within(notice).getByRole('button', { name: 'Retry' })).toBeDefined();
    });
  });
});
