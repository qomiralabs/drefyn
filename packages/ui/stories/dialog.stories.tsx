import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';
import { Button, Dialog, TextField } from '../src/react/index.ts';

const meta = {
  title: 'Components/Dialog',
  parameters: {
    docs: {
      description: {
        component:
          'For a task that needs input, never to ask “are you sure” about something Undo can reverse. Focus moves to the first field, or to the dialog, which reads its title, when there is none. Tab stays inside; Escape and the close button close it and return focus to the trigger, except while a submit is in flight. A click outside does nothing, so typed input is never lost. Below 640 px it rises from the bottom edge. Stories that start open do so only in their own view.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

const openInStoryView = (context?: { viewMode?: string }) => context?.viewMode !== 'docs';

function Frame({ children }: { children: (run: (what: string) => void) => ReactNode }) {
  const [last, setLast] = useState('none');
  return (
    <div className="flex flex-col items-start gap-16 p-24 sm:p-48">
      {children(setLast)}
      <output aria-live="polite" className="text-body-s text-secondary">
        Last action: {last}
      </output>
    </div>
  );
}

interface InviteProps {
  run: (what: string) => void;
  defaultOpen?: boolean;
  busy?: boolean;
  error?: string;
}

function Invite({ run, defaultOpen = false, busy = false, error }: InviteProps) {
  return (
    <Dialog
      trigger="Invite people"
      variant="primary"
      title="Invite people"
      description="They get an email with a link that works for seven days."
      defaultOpen={defaultOpen}
      busy={busy}
      {...(error === undefined ? {} : { error })}
      footer={(close) => (
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            form="invite"
            busy={busy}
            busyLabel="Sending invites"
          >
            Send invites
          </Button>
        </>
      )}
    >
      <form
        id="invite"
        className="flex flex-col gap-16"
        onSubmit={(event) => {
          event.preventDefault();
          run('Sent invites');
        }}
      >
        <TextField
          id="invite-email"
          name="email"
          type="email"
          label="Email addresses"
          description="Separate addresses with commas."
          placeholder="ada@example.com"
          {...(error === undefined ? {} : { error: 'Enter at least one address.' })}
        />
        <TextField id="invite-note" name="note" label="Note" description="Optional." />
      </form>
    </Dialog>
  );
}

export const Default: Story = {
  render: () => <Frame>{(run) => <Invite run={run} />}</Frame>,
};

export const Open: Story = {
  render: (_args, context) => (
    <Frame>{(run) => <Invite run={run} defaultOpen={openInStoryView(context)} />}</Frame>
  ),
};

// While the invites send, the primary button says so, the dialog is aria-busy, and Escape
// and the close button wait.
export const Submitting: Story = {
  tags: ['busy', 'disabled'],
  render: (_args, context) => (
    <Frame>{(run) => <Invite run={run} defaultOpen={openInStoryView(context)} busy />}</Frame>
  ),
};

export const Failed: Story = {
  render: (_args, context) => (
    <Frame>
      {(run) => (
        <Invite
          run={run}
          defaultOpen={openInStoryView(context)}
          error="Could not send the invites. Nothing was sent; try again."
        />
      )}
    </Frame>
  ),
};

// A dialog the caller opens, such as from a keyboard shortcut, with no field inside.
export const NoFields: Story = {
  name: 'No fields',
  render: () => (
    <Frame>
      {() => (
        <Dialog trigger="Keyboard shortcuts" variant="quiet" title="Keyboard shortcuts">
          <dl className="grid grid-cols-2 gap-8 text-body-s">
            <dt className="text-secondary">Search</dt>
            <dd className="text-body">Cmd K</dd>
            <dt className="text-secondary">Undo the last change</dt>
            <dd className="text-body">Cmd Z</dd>
          </dl>
        </Dialog>
      )}
    </Frame>
  ),
};
