import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { Select, SelectOption } from '../src/react/index.ts';

const meta = {
  title: 'Components/Select',
  parameters: {
    docs: {
      description: {
        component:
          'One choice from a short fixed list, under about fifteen options: a role, a region, a plan. For a list that needs typing to search, use a combobox. A hidden native select carries the value, so a form posts it. Keyboard: Enter, Space or the arrow keys open the list; the arrows, Home and End move; typing a letter jumps; Enter chooses and closes; Escape closes and returns focus to the trigger. On a closed trigger, typing a letter chooses the match. A disabled option stays reachable by the arrows and is announced as unavailable. A disabled select stays focusable so its reason can be read. Stories that start open do so only in their own view, so this page stays readable.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="flex max-w-measure flex-col gap-24 p-24 sm:p-48">{children}</div>
);

// A select that starts open is modal: it would cover this docs page and hide the rest from
// screen readers. So it starts open only in its own story view.
const openInStoryView = (context?: { viewMode?: string }) => context?.viewMode !== 'docs';

function Regions() {
  return (
    <Select
      label="Region"
      name="region"
      placeholder="Choose a region"
      description="Pages are served from here."
    >
      <SelectOption value="eu" description="Frankfurt and Dublin">
        Europe
      </SelectOption>
      <SelectOption value="us" description="Virginia and Oregon">
        United States
      </SelectOption>
      <SelectOption value="ap" disabled description="Not on your plan">
        Asia Pacific
      </SelectOption>
      <SelectOption value="sa">South America</SelectOption>
    </Select>
  );
}

export const Default: Story = {
  render: () => (
    <Frame>
      <Regions />
    </Frame>
  ),
};

export const Chosen: Story = {
  render: () => (
    <Frame>
      <Select label="Role" name="role" defaultValue="editor">
        <SelectOption value="owner">Owner</SelectOption>
        <SelectOption value="editor">Editor</SelectOption>
        <SelectOption value="viewer">Viewer</SelectOption>
      </Select>
    </Frame>
  ),
};

export const Open: Story = {
  tags: ['disabled'],
  render: (_args, context) => (
    <Frame>
      <Select label="Region" name="region" defaultValue="eu" defaultOpen={openInStoryView(context)}>
        <SelectOption value="eu" description="Frankfurt and Dublin">
          Europe
        </SelectOption>
        <SelectOption value="us" description="Virginia and Oregon">
          United States
        </SelectOption>
        <SelectOption value="ap" disabled description="Not on your plan">
          Asia Pacific
        </SelectOption>
        <SelectOption value="sa">South America</SelectOption>
      </Select>
    </Frame>
  ),
};

export const Invalid: Story = {
  render: () => (
    <Frame>
      <Select
        label="Plan"
        name="plan"
        placeholder="Choose a plan"
        required
        error="Choose a plan to start the trial."
      >
        <SelectOption value="free">Free</SelectOption>
        <SelectOption value="team">Team</SelectOption>
        <SelectOption value="business">Business</SelectOption>
      </Select>
    </Frame>
  ),
};

export const Disabled: Story = {
  tags: ['disabled'],
  render: () => (
    <Frame>
      <Select
        label="Data region"
        name="region"
        defaultValue="eu"
        disabled
        description="The region is fixed once the site has pages."
      >
        <SelectOption value="eu">Europe</SelectOption>
        <SelectOption value="us">United States</SelectOption>
      </Select>
    </Frame>
  ),
};

export const Loading: Story = {
  render: (_args, context) => (
    <Frame>
      <Select
        label="Monitor"
        name="monitor"
        placeholder="Choose a monitor"
        loading
        defaultOpen={openInStoryView(context)}
      >
        {[]}
      </Select>
    </Frame>
  ),
};

export const Sizes: Story = {
  render: () => (
    <Frame>
      <Select label="Medium, for the dashboard" defaultValue="60">
        <SelectOption value="30">Every 30 seconds</SelectOption>
        <SelectOption value="60">Every minute</SelectOption>
      </Select>
      <Select label="Large, for public forms" size="lg" placeholder="Choose a topic">
        <SelectOption value="billing">Billing</SelectOption>
        <SelectOption value="outage">An outage</SelectOption>
      </Select>
    </Frame>
  ),
};
