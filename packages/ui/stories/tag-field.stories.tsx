import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { Button, Dialog, TagField } from '../src/react/index.ts';

const meta = {
  title: 'Components/Tag field',
  parameters: {
    docs: {
      description: {
        component:
          'Several free text values in one field, each a removable chip, such as addresses to invite. A chip can carry its own error, which is the reason to use this over one comma separated text field. For picks from a known list, use MultiCombobox. Keyboard: Enter or a comma adds what was typed, and leaving the field adds it too; a paste of several values adds each one. Backspace or the left arrow at the start of an empty input steps onto the last chip; Backspace or Delete on a chip removes it, and focus moves to the next chip, or to the input after the last. The arrows move between chips, and Tab goes from a chip to its remove button and on to the input. Enter submits the form once the input is empty. Below 640 px the field stays in place, because there is no list to open. A disabled field stays focusable so its reason can be read.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="flex max-w-measure flex-col gap-24 p-24 sm:p-48">{children}</div>
);

const HINT = 'Type or paste addresses. Enter or a comma adds each one.';

export const Default: Story = {
  render: () => (
    <Frame>
      <TagField
        label="Email addresses"
        tagsLabel="Addresses to invite"
        name="to"
        inputMode="email"
        description={HINT}
      />
    </Frame>
  ),
};

export const Filled: Story = {
  render: () => (
    <Frame>
      <TagField
        label="Email addresses"
        tagsLabel="Addresses to invite"
        name="to"
        inputMode="email"
        description={HINT}
        defaultValue={['kai@acme.dev', 'ren@northwind.dev']}
      />
    </Frame>
  ),
};

// Each address was checked and two came back with a reason.
export const InvalidTags: Story = {
  name: 'Invalid tags',
  render: () => (
    <Frame>
      <TagField
        label="Email addresses"
        tagsLabel="Addresses to invite"
        name="to"
        inputMode="email"
        description={HINT}
        defaultValue={['kai@acme.dev', 'lee.k@acme', 'sam@acme.dev']}
        tagErrors={{
          'lee.k@acme': 'lee.k@acme is not a full address. Did you mean lee.k@acme.dev?',
          'sam@acme.dev': 'sam@acme.dev is already in Acme.',
        }}
      />
    </Frame>
  ),
};

export const Invalid: Story = {
  render: () => (
    <Frame>
      <TagField
        label="Email addresses"
        tagsLabel="Addresses to invite"
        name="to"
        required
        error="Add at least one address to send invitations."
      />
    </Frame>
  ),
};

export const Disabled: Story = {
  tags: ['disabled'],
  render: () => (
    <Frame>
      <TagField
        label="Email addresses"
        tagsLabel="Addresses to invite"
        name="to"
        disabled
        description="Invitations are closed on this plan."
        defaultValue={['kai@acme.dev']}
      />
    </Frame>
  ),
};

export const InADialog: Story = {
  name: 'In a dialog',
  render: () => (
    <Frame>
      <Dialog
        trigger="Invite someone"
        title="Invite people"
        footer={(close) => (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" onClick={close}>
              Send invitations
            </Button>
          </>
        )}
      >
        <TagField
          label="Email addresses"
          tagsLabel="Addresses to invite"
          name="to"
          inputMode="email"
          description={HINT}
        />
      </Dialog>
    </Frame>
  ),
};
