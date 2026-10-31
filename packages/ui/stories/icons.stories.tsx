import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  IconAlert,
  IconCard,
  IconChart,
  IconCheck,
  IconChevronDown,
  IconClock,
  IconCode,
  IconCommit,
  IconCross,
  IconGlobe,
  IconHatch,
  IconHome,
  IconInbox,
  IconIncident,
  IconLock,
  IconMenu,
  IconMore,
  IconPage,
  IconPulse,
  IconSchema,
  IconSearch,
  IconSettings,
  IconUpDown,
  IconUsers,
  Mark,
} from '../src/react/index.ts';

const meta = {
  title: 'Components/Icons',
  parameters: {
    docs: {
      description: {
        component:
          'Our own icons on the 24 grid: 1.5 px stroke from the token, square terminals, no fill, the current text colour. Decorative by default; pass label for an icon that carries meaning without visible text. The Drefyn mark sits on its own 100 unit grid with its stroke drawn in.',
      },
    },
  },
} satisfies Meta;

export default meta;

const icons = [
  { name: 'Alert', Icon: IconAlert },
  { name: 'Card', Icon: IconCard },
  { name: 'Chart', Icon: IconChart },
  { name: 'Check', Icon: IconCheck },
  { name: 'Chevron down', Icon: IconChevronDown },
  { name: 'Clock', Icon: IconClock },
  { name: 'Code', Icon: IconCode },
  { name: 'Commit', Icon: IconCommit },
  { name: 'Cross', Icon: IconCross },
  { name: 'Globe', Icon: IconGlobe },
  { name: 'Hatch', Icon: IconHatch },
  { name: 'Home', Icon: IconHome },
  { name: 'Inbox', Icon: IconInbox },
  { name: 'Incident', Icon: IconIncident },
  { name: 'Lock', Icon: IconLock },
  { name: 'Menu', Icon: IconMenu },
  { name: 'More', Icon: IconMore },
  { name: 'Page', Icon: IconPage },
  { name: 'Pulse', Icon: IconPulse },
  { name: 'Schema', Icon: IconSchema },
  { name: 'Search', Icon: IconSearch },
  { name: 'Settings', Icon: IconSettings },
  { name: 'Up and down', Icon: IconUpDown },
  { name: 'Users', Icon: IconUsers },
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

export const DrefynMark: StoryObj = {
  name: 'Mark',
  render: () => (
    <div className="flex items-center gap-12 p-24 text-ink sm:p-48">
      <Mark size="sm" />
      <Mark size="md" />
      <Mark size="lg" />
      <span className="text-body-s text-body">Mark</span>
    </div>
  ),
};
