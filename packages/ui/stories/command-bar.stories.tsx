import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ComponentProps } from 'react';
import {
  Button,
  CommandBar,
  IconHome,
  IconIncident,
  IconPage,
  IconPulse,
  IconSearch,
  IconUsers,
} from '../src/react/index.ts';

const meta = {
  title: 'Components/Command bar',
  parameters: {
    docs: {
      description: {
        component:
          'The surface the shell opens on Cmd+K or Ctrl+K; the shell owns the shortcut and what is listed. Focus stays in the field while the arrows move the highlighted row, which the field names to screen readers through aria-activedescendant. Keyboard: type to filter by name, place or group; the arrows, Home and End move; Enter runs the row and closes; Escape clears the query, then closes, and focus returns to what opened it. Rows that share a group are listed under its word. A disabled row stays reachable and reads its reason. Loading keeps the field still and draws skeleton rows; a failed search offers Retry as a row. Below 640 px it fills the screen and Cancel closes it. Stories that start open do so only in their own view.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

type Items = ComponentProps<typeof CommandBar>['items'];

const ITEMS: Items = [
  { id: 'overview', label: 'Overview', context: 'Acme', group: 'Go to', icon: <IconHome /> },
  {
    id: 'status',
    label: 'Status page',
    context: 'status.acme.com',
    group: 'Go to',
    icon: <IconPulse />,
  },
  { id: 'docs', label: 'Payments API docs', context: 'Docs', group: 'Go to', icon: <IconPage /> },
  {
    id: 'incidents',
    label: 'Incidents',
    context: 'Status',
    group: 'Go to',
    icon: <IconIncident />,
  },
  {
    id: 'incident',
    label: 'Start an incident',
    context: 'Status',
    group: 'Actions',
    icon: <IconIncident />,
    shortcut: 'I',
  },
  {
    id: 'invite',
    label: 'Invite people',
    context: 'Members',
    group: 'Actions',
    icon: <IconUsers />,
  },
];

const DELETE: Items[number] = {
  id: 'delete',
  label: 'Delete the project',
  context: 'Settings',
  group: 'Actions',
  disabled: true,
  reason: 'Only an owner can delete a project',
};

// A command bar that starts open is modal: it would cover this docs page. So it starts open
// only in its own story view.
const openInStoryView = (context?: { viewMode?: string }) => context?.viewMode !== 'docs';

type BarProps = Partial<ComponentProps<typeof CommandBar>> & { startOpen?: boolean };

// The opener and an output of the last command run, so tests and readers see what ran.
function Bar({ startOpen = false, items = ITEMS, ...props }: BarProps) {
  const [open, setOpen] = useState(startOpen);
  const [last, setLast] = useState('none');
  return (
    <div className="flex flex-col items-start gap-16 p-24 sm:p-48">
      <Button
        onClick={() => {
          setOpen(true);
        }}
      >
        <IconSearch />
        Search
      </Button>
      <CommandBar
        open={open}
        onOpenChange={setOpen}
        items={items}
        onAction={setLast}
        scope="In Acme"
        {...props}
      />
      <output aria-live="polite" className="text-body-s text-secondary">
        Last command: {last}
      </output>
    </div>
  );
}

export const Default: Story = {
  render: () => <Bar />,
};

export const Open: Story = {
  render: (_args, context) => <Bar startOpen={openInStoryView(context)} />,
};

export const Filtered: Story = {
  render: (_args, context) => <Bar startOpen={openInStoryView(context)} defaultQuery="stat" />,
};

export const NoResults: Story = {
  name: 'No results',
  render: (_args, context) => <Bar startOpen={openInStoryView(context)} defaultQuery="zebra" />,
};

export const Loading: Story = {
  render: (_args, context) => <Bar startOpen={openInStoryView(context)} items={[]} loading />,
};

function FailedBar({ startOpen }: { startOpen: boolean }) {
  const [retries, setRetries] = useState(0);
  return (
    <>
      <Bar
        startOpen={startOpen}
        items={[]}
        error="Search is not answering. Your work is safe."
        onRetry={() => {
          setRetries((n) => n + 1);
        }}
      />
      <p className="px-24 text-body-s text-secondary sm:px-48">Retries: {retries}</p>
    </>
  );
}

export const Failed: Story = {
  render: (_args, context) => <FailedBar startOpen={openInStoryView(context)} />,
};

export const Disabled: Story = {
  tags: ['disabled'],
  render: (_args, context) => (
    <Bar startOpen={openInStoryView(context)} items={[...ITEMS, DELETE]} />
  ),
};
