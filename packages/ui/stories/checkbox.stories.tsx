import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';
import { Checkbox } from '../src/react/index.ts';

const meta = {
  title: 'Components/Checkbox',
  parameters: {
    docs: {
      description: {
        component:
          'For a choice that waits for a Save button, or one of several picks in a list. A setting that applies at once is a Switch. A real checkbox input sits under the drawn box, so a form posts it with no script. Keyboard: Tab focuses, Space toggles; Enter is left to the form. Indeterminate means some of what the box stands for is checked, such as a select all box over a table, and is read as mixed. A disabled box stays focusable so its reason can be read. Pass error after a submit or on blur, never on each change.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="flex max-w-measure flex-col gap-16 p-24 sm:p-48">{children}</div>
);

export const Default: Story = {
  render: () => (
    <Frame>
      <Checkbox name="stale">Email me when a page goes stale</Checkbox>
    </Frame>
  ),
};

export const Checked: Story = {
  render: () => (
    <Frame>
      <Checkbox name="broken" defaultChecked>
        Email me when a link breaks
      </Checkbox>
    </Frame>
  ),
};

// A select all box over three rows: it is mixed while some rows are picked.
function SelectAll() {
  const rows = ['Getting started', 'Billing API', 'Webhooks'];
  const [picked, setPicked] = useState<string[]>(['Billing API']);
  const all = picked.length === rows.length;
  return (
    <Frame>
      <Checkbox
        checked={all}
        indeterminate={picked.length > 0 && !all}
        onChange={(next) => {
          setPicked(next ? rows : []);
        }}
      >
        Select all pages
      </Checkbox>
      <div className="flex flex-col gap-8 ps-24">
        {rows.map((row) => (
          <Checkbox
            key={row}
            checked={picked.includes(row)}
            onChange={(next) => {
              setPicked((now) => (next ? [...now, row] : now.filter((r) => r !== row)));
            }}
          >
            {row}
          </Checkbox>
        ))}
      </div>
    </Frame>
  );
}

export const Indeterminate: Story = {
  render: () => <SelectAll />,
};

export const WithDescription: Story = {
  name: 'With description',
  render: () => (
    <Frame>
      <Checkbox name="digest" description="One email a day at 9:00, only when something changed.">
        Send a daily digest
      </Checkbox>
    </Frame>
  ),
};

export const Invalid: Story = {
  render: () => (
    <Frame>
      <Checkbox
        name="terms"
        required
        description="You can export or delete your data at any time."
        error="Agree to the terms to create the site."
      >
        I agree to the terms of service
      </Checkbox>
    </Frame>
  ),
};

export const Disabled: Story = {
  tags: ['disabled'],
  render: () => (
    <Frame>
      <Checkbox disabled description="Only owners can change billing alerts.">
        Email me before a renewal
      </Checkbox>
      <Checkbox disabled defaultChecked description="Security alerts always go to owners.">
        Email me about sign ins
      </Checkbox>
    </Frame>
  ),
};
