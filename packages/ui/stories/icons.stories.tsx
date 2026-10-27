import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  IconAlert,
  IconCheck,
  IconChevronDown,
  IconClock,
  IconCross,
  IconHatch,
  IconMore,
} from '../src/react/index.ts';

const meta = {
  title: 'Components/Icons',
  parameters: {
    docs: {
      description: {
        component:
          'Our own icons on the 24 grid: 1.5 px stroke from the token, square terminals, no fill, the current text colour. Decorative by default; pass label for an icon that carries meaning without visible text.',
      },
    },
  },
} satisfies Meta;

export default meta;

const icons = [
  { name: 'Alert', Icon: IconAlert },
  { name: 'Check', Icon: IconCheck },
  { name: 'Chevron down', Icon: IconChevronDown },
  { name: 'Clock', Icon: IconClock },
  { name: 'Cross', Icon: IconCross },
  { name: 'Hatch', Icon: IconHatch },
  { name: 'More', Icon: IconMore },
];

export const All: StoryObj = {
  render: () => (
    <div className="p-24 sm:p-48">
      <ul className="grid gap-16 sm:grid-cols-4">
        {icons.map(({ name, Icon }) => (
          <li key={name} className="flex items-center gap-12 text-body">
            <Icon size="sm" />
            <Icon size="md" />
            <Icon size="lg" />
            <span className="text-body-s">{name}</span>
          </li>
        ))}
      </ul>
    </div>
  ),
};
