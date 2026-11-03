import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';
import { Button, EmptyState, IconPage, Table } from '../src/react/index.ts';

const meta = {
  title: 'Components/Table',
  parameters: {
    docs: {
      description: {
        component:
          'Lists people scan and act on: pages, monitors, members. A grid with one Tab stop. Keyboard: the arrows move by row, and into cells and headers; Home and End jump to the first and last row; Enter opens the focused row, or sorts by the focused header (again to reverse); Space selects the focused row. A disabled row stays reachable and readable with its reason, and cannot be selected or opened. Figures are end aligned in tabular numbers. Loading keeps the header and draws skeleton rows; an empty or failed first load replaces the rows inside the frame; a failed refresh keeps the rows and says so above them. Below 640 px the frame scrolls sideways.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

interface Page {
  id: string;
  title: string;
  views: number;
  edited: string;
}

const PAGES: Page[] = [
  { id: 'refunds', title: 'Refunds', views: 1_204, edited: '2 hours ago' },
  { id: 'payouts', title: 'Create a payout', views: 4_800, edited: 'Yesterday' },
  { id: 'keys', title: 'API keys', views: 960, edited: '21 Oct' },
  { id: 'webhooks', title: 'Webhooks', views: 88, edited: '14 Oct' },
];

const COLUMNS = [
  {
    id: 'title',
    label: 'Page',
    rowHeader: true,
    cell: (p: Page) => <span className="text-ink">{p.title}</span>,
    sortValue: (p: Page) => p.title,
  },
  {
    id: 'views',
    label: 'Views',
    numeric: true,
    cell: (p: Page) => p.views.toLocaleString('en-GB'),
    sortValue: (p: Page) => p.views,
  },
  { id: 'edited', label: 'Edited', cell: (p: Page) => p.edited },
];

const NONE = (
  <EmptyState title="No pages yet" headingLevel={3} icon={<IconPage size="lg" />}>
    Pages show here once the first one is published.
  </EmptyState>
);

// The last opened row is written to a live output, so tests and readers see what ran.
function Frame({ children }: { children: (open: (id: string) => void) => ReactNode }) {
  const [last, setLast] = useState('none');
  return (
    <div className="flex max-w-landing flex-col gap-16 p-16 sm:p-48">
      {children((id) => {
        setLast(PAGES.find((p) => p.id === id)?.title ?? id);
      })}
      <output aria-live="polite" className="text-body-s text-secondary">
        Last opened: {last}
      </output>
    </div>
  );
}

export const Default: Story = {
  render: () => (
    <Frame>
      {(open) => (
        <>
          <Table<Page>
            label="Pages"
            columns={COLUMNS}
            rows={PAGES}
            empty={NONE}
            onRowAction={open}
          />
          <div>
            <Button size="sm">Load more</Button>
          </div>
        </>
      )}
    </Frame>
  ),
};

export const Selection: Story = {
  render: () => (
    <Frame>
      {(open) => (
        <Table<Page>
          label="Pages"
          columns={COLUMNS}
          rows={PAGES}
          empty={NONE}
          selectable
          defaultSort={{ column: 'views', direction: 'descending' }}
          onRowAction={open}
        />
      )}
    </Frame>
  ),
};

export const DisabledRows: Story = {
  name: 'Disabled rows',
  tags: ['disabled'],
  render: () => (
    <Frame>
      {(open) => (
        <Table<Page>
          label="Pages"
          columns={COLUMNS}
          rows={PAGES}
          empty={NONE}
          selectable
          defaultSelected={['refunds']}
          disabledRows={{ keys: 'Managed by the API reference' }}
          onRowAction={open}
        />
      )}
    </Frame>
  ),
};

export const Comfortable: Story = {
  render: () => (
    <Frame>
      {(open) => (
        <Table<Page>
          label="Pages"
          columns={COLUMNS}
          rows={PAGES}
          empty={NONE}
          density="comfortable"
          onRowAction={open}
        />
      )}
    </Frame>
  ),
};

export const Loading: Story = {
  render: () => (
    <Frame>
      {() => <Table<Page> label="Pages" columns={COLUMNS} rows={[]} empty={NONE} loading />}
    </Frame>
  ),
};

export const Empty: Story = {
  render: () => (
    <Frame>{() => <Table<Page> label="Pages" columns={COLUMNS} rows={[]} empty={NONE} />}</Frame>
  ),
};

export const Failed: Story = {
  render: () => (
    <Frame>
      {() => (
        <Table<Page>
          label="Pages"
          columns={COLUMNS}
          rows={[]}
          empty={NONE}
          error="The pages service did not answer. Your pages are safe."
          onRetry={() => undefined}
        />
      )}
    </Frame>
  ),
};

export const RefreshFailed: Story = {
  name: 'Refresh failed',
  render: () => (
    <Frame>
      {(open) => (
        <Table<Page>
          label="Pages"
          columns={COLUMNS}
          rows={PAGES}
          empty={NONE}
          error="Could not refresh. Showing pages from 14:02."
          onRetry={() => undefined}
          onRowAction={open}
        />
      )}
    </Frame>
  ),
};
