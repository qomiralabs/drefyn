import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps, ReactNode } from 'react';
import { Button, Dialog, MultiCombobox, SelectOption } from '../src/react/index.ts';

const meta = {
  title: 'Components/Multi combobox',
  parameters: {
    docs: {
      description: {
        component:
          'Several picks from a known list, with a search, for lists too long for checkboxes: the projects an API key can reach. For one pick from a short list, use Select. For free text, use TagField. Each pick shows as a removable chip, and a hidden input per chip posts the value. Keyboard: typing filters and opens the list; the down and up arrows open it and move; Enter adds or takes off the active option and leaves the list open with the search kept, so several picks are quick; Escape closes the list and clears the search; Tab closes it and moves on without picking. A press in the input opens the whole list. Backspace or the left arrow at the start of an empty input steps onto the last chip, where Backspace or Delete removes it. Below 640 px the box shows a button that opens a bottom sheet titled by the label, holding the search and a list of 40 px rows; inside a dialog it opens as a second sheet over it and closes back to it. A disabled option stays reachable by the arrows and reads its reason. A disabled field stays focusable so its reason can be read. Stories that start open do so only in their own view, so this page stays readable.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="flex max-w-measure flex-col gap-24 p-24 sm:p-48">{children}</div>
);

// A list that starts open covers what is under it, so on the docs page it stays shut.
const openInStoryView = (context?: { viewMode?: string }) => context?.viewMode !== 'docs';

const count = (matches: number, total: number, query: string) =>
  `${String(matches)} of ${String(total)} projects match ${query}`;

function Projects(props: Partial<ComponentProps<typeof MultiCombobox>>) {
  return (
    <MultiCombobox
      label="Projects"
      tagsLabel="Projects this key can reach"
      name="projects"
      placeholder="Search projects"
      emptyText="No projects match"
      countLabel={count}
      {...props}
    >
      <SelectOption value="payments" description="Docs">
        Payments API docs
      </SelectOption>
      <SelectOption value="partner" description="Docs">
        Partner API docs
      </SelectOption>
      <SelectOption value="status" description="Status">
        Status page
      </SelectOption>
      <SelectOption value="old" disabled description="Archived, so no key can reach it">
        Old site
      </SelectOption>
    </MultiCombobox>
  );
}

export const Default: Story = {
  render: () => (
    <Frame>
      <Projects />
    </Frame>
  ),
};

export const Chosen: Story = {
  render: () => (
    <Frame>
      <Projects defaultValue={['payments', 'partner']} />
    </Frame>
  ),
};

export const Open: Story = {
  tags: ['disabled'],
  render: (_args, context) => (
    <Frame>
      <Projects defaultValue={['payments']} defaultOpen={openInStoryView(context)} />
    </Frame>
  ),
};

export const Filtered: Story = {
  render: (_args, context) => (
    <Frame>
      <Projects
        defaultValue={['payments', 'partner']}
        defaultOpen={openInStoryView(context)}
        defaultSearch={openInStoryView(context) ? 'docs' : ''}
      />
    </Frame>
  ),
};

export const NoMatches: Story = {
  name: 'No matches',
  render: (_args, context) => (
    <Frame>
      <Projects
        defaultOpen={openInStoryView(context)}
        defaultSearch={openInStoryView(context) ? 'billing' : ''}
      />
    </Frame>
  ),
};

export const EmptyList: Story = {
  name: 'Empty list',
  render: (_args, context) => (
    <Frame>
      <MultiCombobox
        label="Projects"
        placeholder="Search projects"
        emptyText="No projects yet"
        defaultOpen={openInStoryView(context)}
      >
        {[]}
      </MultiCombobox>
    </Frame>
  ),
};

export const Loading: Story = {
  render: (_args, context) => (
    <Frame>
      <MultiCombobox
        label="Projects"
        placeholder="Search projects"
        loading
        defaultValue={['payments']}
        defaultOpen={openInStoryView(context)}
      >
        {[]}
      </MultiCombobox>
    </Frame>
  ),
};

export const Invalid: Story = {
  render: () => (
    <Frame>
      <Projects required error="Choose at least one project, or give the key every project." />
    </Frame>
  ),
};

export const Disabled: Story = {
  tags: ['disabled'],
  render: () => (
    <Frame>
      <Projects
        disabled
        defaultValue={['payments']}
        description="Only an owner can change what a key reaches."
      />
    </Frame>
  ),
};

// The API key dialog's picker: on a phone the list opens as a second sheet over the dialog.
export const InADialog: Story = {
  name: 'In a dialog',
  render: () => (
    <Frame>
      <Dialog
        trigger="Create key"
        title="Create an API key"
        footer={(close) => (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" onClick={close}>
              Create key
            </Button>
          </>
        )}
      >
        <Projects defaultValue={['payments']} />
      </Dialog>
    </Frame>
  ),
};
