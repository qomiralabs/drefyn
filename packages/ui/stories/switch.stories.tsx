import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { Switch } from '../src/react/index.ts';

const meta = {
  title: 'Components/Switch',
  parameters: {
    docs: {
      description: {
        component:
          'For a setting that applies at once and can be undone, never inside a form with a Save button. The thumb position and the switch role carry on and off; the description says what the setting does. Keyboard: Tab focuses, Space flips. A disabled switch stays focusable so its reason can be read.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="flex max-w-measure flex-col gap-24 p-24 sm:p-48">{children}</div>
);

export const Off: Story = {
  render: () => (
    <Frame>
      <Switch description="Shows the 90 day figure under each component.">
        Show uptime figure
      </Switch>
    </Frame>
  ),
};

export const On: Story = {
  render: () => (
    <Frame>
      <Switch defaultChecked description="A status changes only when two regions see the same.">
        Require two regions to agree
      </Switch>
    </Frame>
  ),
};

export const Disabled: Story = {
  tags: ['disabled'],
  render: () => (
    <Frame>
      <Switch disabled description="Only owners can change who sees this page.">
        Private page
      </Switch>
      <Switch disabled defaultChecked description="Your plan includes one custom domain.">
        Custom domain
      </Switch>
    </Frame>
  ),
};

export const Settings: Story = {
  render: () => (
    <Frame>
      <Switch defaultChecked description="A status changes only when two regions see the same.">
        Require two regions to agree
      </Switch>
      <Switch description="Shows the 90 day figure under each component.">
        Show uptime figure
      </Switch>
      <Switch description="Readers can subscribe to updates by email.">Email updates</Switch>
    </Frame>
  ),
};
