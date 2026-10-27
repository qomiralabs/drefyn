import type { Meta, StoryObj } from '@storybook/react-vite';
import { StatusDot } from '../src/react/index.ts';

const meta = {
  title: 'Components/Status dot',
  parameters: {
    docs: {
      description: {
        component:
          'A static dot beside a word. Teal means live right now. The word is always visible, because amber and teal dots never stand alone. Nothing pulses.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const States: Story = {
  render: () => (
    <div className="p-24 sm:p-48">
      <ul className="flex flex-wrap gap-16 text-body-s">
        <li>
          <StatusDot state="fresh">Operational</StatusDot>
        </li>
        <li>
          <StatusDot state="stale">Degraded</StatusDot>
        </li>
        <li>
          <StatusDot state="broken">Partial outage</StatusDot>
        </li>
        <li>
          <StatusDot state="neutral">No data</StatusDot>
        </li>
      </ul>
    </div>
  ),
};

export const Live: Story = {
  render: () => (
    <div className="p-24 sm:p-48">
      <ul className="flex flex-wrap gap-16 text-body-s">
        <li>
          <StatusDot state="live">Syncing</StatusDot>
        </li>
        <li>
          <StatusDot state="live">Agent drafting an update</StatusDot>
        </li>
        <li>
          <StatusDot state="live">
            <data value="3">3</data> viewing
          </StatusDot>
        </li>
      </ul>
    </div>
  ),
};
