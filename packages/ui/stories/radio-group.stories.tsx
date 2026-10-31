import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { Radio, RadioGroup } from '../src/react/index.ts';

const meta = {
  title: 'Components/Radio group',
  parameters: {
    docs: {
      description: {
        component:
          'One choice from a short list that stays on screen. For a long list or little room, use a Select. Native radio inputs sit under the drawn circles, so a form posts the choice with no script. Keyboard: Tab enters on the chosen radio, or the first when none is chosen; the arrow keys move and choose; Tab leaves the group. A disabled radio stays reachable by the arrows and is announced as unavailable, but is never chosen. A disabled group keeps every radio focusable so its reason can be read.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="flex max-w-measure flex-col gap-24 p-24 sm:p-48">{children}</div>
);

export const Default: Story = {
  render: () => (
    <Frame>
      <RadioGroup label="Role" name="role" defaultValue="editor">
        <Radio value="owner">Owner</Radio>
        <Radio value="editor">Editor</Radio>
        <Radio value="viewer">Viewer</Radio>
      </RadioGroup>
    </Frame>
  ),
};

export const WithDescriptions: Story = {
  name: 'With descriptions',
  render: () => (
    <Frame>
      <RadioGroup
        label="Who can see this page"
        name="audience"
        description="You can change this at any time."
      >
        <Radio value="public" description="Anyone with the link, and search engines.">
          Public
        </Radio>
        <Radio value="members" description="People in your organization after they sign in.">
          Members
        </Radio>
        <Radio value="private" description="Only you and the owners.">
          Private
        </Radio>
      </RadioGroup>
    </Frame>
  ),
};

export const Horizontal: Story = {
  render: () => (
    <Frame>
      <RadioGroup label="Check every" name="interval" defaultValue="60" orientation="horizontal">
        <Radio value="30">30 seconds</Radio>
        <Radio value="60">1 minute</Radio>
        <Radio value="300">5 minutes</Radio>
      </RadioGroup>
    </Frame>
  ),
};

export const Invalid: Story = {
  render: () => (
    <Frame>
      <RadioGroup label="Role" name="role" required error="Choose a role to send the invite.">
        <Radio value="owner">Owner</Radio>
        <Radio value="editor">Editor</Radio>
        <Radio value="viewer">Viewer</Radio>
      </RadioGroup>
    </Frame>
  ),
};

export const Disabled: Story = {
  tags: ['disabled'],
  render: () => (
    <Frame>
      <RadioGroup label="Role" name="role" defaultValue="editor">
        <Radio value="owner" disabled description="Only an owner can make another owner.">
          Owner
        </Radio>
        <Radio value="editor">Editor</Radio>
        <Radio value="viewer">Viewer</Radio>
      </RadioGroup>
      <RadioGroup
        label="Data region"
        name="region"
        defaultValue="eu"
        disabled
        description="The region is fixed once the site has pages."
      >
        <Radio value="eu">Europe</Radio>
        <Radio value="us">United States</Radio>
      </RadioGroup>
    </Frame>
  ),
};
