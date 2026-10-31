import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { TextField } from '../src/react/index.ts';

const meta = {
  title: 'Components/Text field',
  parameters: {
    docs: {
      description: {
        component:
          'A native input with its label, an optional description and an error message, wired by the id you pass, so it renders on the server and posts with no script. Validate on blur and on submit, never on each key; on a failed submit, move focus to the first invalid field. A disabled field stays focusable and read only, so its reason can be read. A read only field drops its edge and sits on the raised fill.',
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
      <TextField id="site-name" name="name" label="Site name" defaultValue="Acme docs" />
    </Frame>
  ),
};

export const WithDescription: Story = {
  name: 'With description',
  render: () => (
    <Frame>
      <TextField
        id="site-url"
        name="url"
        type="url"
        label="Custom domain"
        description="Point a CNAME record at sites.drefyn.com first."
        placeholder="docs.example.com"
      />
    </Frame>
  ),
};

export const Invalid: Story = {
  render: () => (
    <Frame>
      <TextField
        id="site-slug"
        name="slug"
        label="Address"
        description="Lowercase letters, numbers and hyphens."
        defaultValue="Acme Docs"
        error="Use lowercase letters, numbers and hyphens, such as acme-docs."
      />
    </Frame>
  ),
};

export const Disabled: Story = {
  tags: ['disabled'],
  render: () => (
    <Frame>
      <TextField
        id="site-owner"
        name="owner"
        label="Owner"
        defaultValue="Ada Lovelace"
        disabled
        description="Only the current owner can hand the site over."
      />
    </Frame>
  ),
};

export const ReadOnly: Story = {
  name: 'Read only',
  render: () => (
    <Frame>
      <TextField
        id="site-id"
        name="id"
        label="Site ID"
        defaultValue="site_fixture_8f2c"
        readOnly
        description="Use this ID in API calls."
      />
    </Frame>
  ),
};

export const Sizes: Story = {
  render: () => (
    <Frame>
      <TextField id="size-md" label="Medium, for the dashboard" placeholder="Search pages" />
      <TextField
        id="size-lg"
        size="lg"
        type="email"
        label="Large, for public forms"
        placeholder="you@example.com"
      />
    </Frame>
  ),
};
