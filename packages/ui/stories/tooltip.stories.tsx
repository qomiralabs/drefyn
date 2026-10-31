import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { Button, IconCheck, IconClock, IconMore, Tooltip } from '../src/react/index.ts';
import { tokens } from '../src/index.ts';

const meta = {
  title: 'Components/Tooltip',
  parameters: {
    docs: {
      description: {
        component: `Short text that describes a control, never its only name. It opens on keyboard focus at once and on hover after ${tokens.timer.tooltip.ms} ms, never on touch, and moving between neighbours is instant. Escape closes it and leaves focus where it was; the pointer can move onto it. Text only: no links or buttons inside. A disabled button stays focusable, so a tooltip can say why it cannot act. Stories that start open do so only in their own view.`,
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="flex flex-wrap items-center gap-12 p-48">{children}</div>
);

const openInStoryView = (context?: { viewMode?: string }) => context?.viewMode !== 'docs';

export const Open: Story = {
  render: (_args, context) => (
    <Frame>
      <Tooltip content="More actions for Checkout" defaultOpen={openInStoryView(context)}>
        <Button variant="quiet" aria-label="More actions for Checkout">
          <IconMore />
        </Button>
      </Tooltip>
    </Frame>
  ),
};

// Neighbouring icon buttons: once one tooltip shows, the next opens without waiting.
export const Toolbar: Story = {
  render: () => (
    <Frame>
      <Button>Edit component</Button>
      <Tooltip content="Mark as verified">
        <Button variant="quiet" aria-label="Mark as verified">
          <IconCheck />
        </Button>
      </Tooltip>
      <Tooltip content="View history">
        <Button variant="quiet" aria-label="View history">
          <IconClock />
        </Button>
      </Tooltip>
      <Tooltip content="More actions">
        <Button variant="quiet" aria-label="More actions">
          <IconMore />
        </Button>
      </Tooltip>
    </Frame>
  ),
};

export const DisabledReason: Story = {
  name: 'Disabled reason',
  tags: ['disabled'],
  render: (_args, context) => (
    <Frame>
      <Tooltip
        content="Only owners can publish this page."
        defaultOpen={openInStoryView(context)}
        placement="bottom"
      >
        <Button variant="primary" disabled>
          Publish update
        </Button>
      </Tooltip>
    </Frame>
  ),
};
