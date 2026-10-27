import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { Button, EmptyState } from '../src/react/index.ts';

const meta = {
  title: 'Components/Empty state',
  parameters: {
    docs: {
      description: {
        component:
          'Replaces the region it belongs to, never the whole page. A heading at the right level, one sentence, and one action, which is the next Tab stop. When an error replaces content after an action, move focus to the heading. No illustration.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="p-24 sm:p-48">
    <div className="rounded-md border border-rule p-24 sm:p-48">{children}</div>
  </div>
);

export const FirstUse: Story = {
  name: 'First use',
  render: () => (
    <Frame>
      <EmptyState
        title="No components yet"
        action={<Button variant="primary">Add component</Button>}
      >
        A component is one thing your customers rely on, such as an API or a checkout page. Bind a
        monitor and its state updates on its own.
      </EmptyState>
    </Frame>
  ),
};

export const NoResults: Story = {
  name: 'No results',
  render: () => (
    <Frame>
      <EmptyState
        title="No pages match 'stale'"
        headingLevel={3}
        action={<Button>Clear filter</Button>}
      >
        Every page in this site was verified in the last 30 days.
      </EmptyState>
    </Frame>
  ),
};

export const ErrorState: Story = {
  name: 'Error',
  render: () => (
    <Frame>
      <EmptyState
        title="Could not load components"
        tone="error"
        reference="req_8f2a91"
        action={<Button>Try again</Button>}
      >
        The request timed out. Nothing was changed. If it keeps happening, send us this reference.
      </EmptyState>
    </Frame>
  ),
};

// Downgrades never delete: over limit content is read only, and the empty state says so.
export const OverLimit: Story = {
  name: 'Over limit',
  render: () => (
    <Frame>
      <EmptyState title="Pages are read only" action={<Button>Change plan</Button>}>
        This project is over its page limit, so pages are read only. Nothing was deleted.
      </EmptyState>
    </Frame>
  ),
};
