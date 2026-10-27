import type { Meta, StoryObj } from '@storybook/react-vite';
import { Badge } from '../src/react/index.ts';

const meta = {
  title: 'Components/Badge',
  parameters: {
    docs: {
      description: {
        component:
          'A state word beside its own shape: a tick, a clock, a cross or a hatch. On ground and raised the word takes its state colour. On anything that can be hovered, pressed or selected, set onFill: the word turns to body text and the icon keeps its colour. No pill fill.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

function All({ onFill = false }: { onFill?: boolean }) {
  return (
    <ul className="flex flex-wrap gap-16">
      <li>
        <Badge state="fresh" onFill={onFill}>
          Verified 2 days ago
        </Badge>
      </li>
      <li>
        <Badge state="stale" onFill={onFill}>
          Out of date for <time dateTime="P2D">2 days</time>
        </Badge>
      </li>
      <li>
        <Badge state="broken" onFill={onFill}>
          Wrong
        </Badge>
      </li>
      <li>
        <Badge state="neutral" onFill={onFill}>
          Maintenance
        </Badge>
      </li>
    </ul>
  );
}

export const States: Story = {
  render: () => (
    <div className="p-24 sm:p-48">
      <All />
    </div>
  ),
};

export const OnRaised: Story = {
  name: 'On raised',
  render: () => (
    <div className="p-24 sm:p-48">
      <div className="rounded-md border border-rule bg-raised p-16">
        <All />
      </div>
    </div>
  ),
};

// A row under the pointer, drawn with the hover fill so the pair can be seen and checked.
export const OnFill: Story = {
  name: 'On a hovered row',
  render: () => (
    <div className="p-24 sm:p-48">
      <div className="bg-hover px-12 py-8">
        <All onFill />
      </div>
    </div>
  ),
};
