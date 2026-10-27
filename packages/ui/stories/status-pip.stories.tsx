import type { Meta, StoryObj } from '@storybook/react-vite';
import { StatusPip } from '../src/react/index.ts';

const meta = {
  title: 'Components/Status pip',
  parameters: {
    docs: {
      description: {
        component:
          'The state shape alone, for dense places where a word does not fit. It always has an accessible name, so screen readers hear the state; sighted readers get a distinct shape per state, never colour alone. Never on a hover or pressed fill.',
      },
    },
  },
} satisfies Meta;

export default meta;

const rows = [
  { name: 'Checkout', state: 'fresh', label: 'Operational' },
  { name: 'Payments API', state: 'stale', label: 'Degraded' },
  { name: 'Webhooks', state: 'broken', label: 'Major outage' },
  { name: 'Legacy API', state: 'neutral', label: 'Maintenance' },
] as const;

export const States: StoryObj = {
  render: () => (
    <div className="p-24 sm:p-48">
      <ul className="max-w-measure">
        {rows.map((row) => (
          <li
            key={row.name}
            className="flex min-h-row-compact items-center justify-between border-t border-rule text-body-s text-body"
          >
            {row.name}
            <StatusPip state={row.state} label={row.label} />
          </li>
        ))}
      </ul>
    </div>
  ),
};
