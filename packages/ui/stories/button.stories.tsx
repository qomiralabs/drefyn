import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';
import { Button, ButtonLink, IconCheck } from '../src/react/index.ts';

// Each press is counted in a live output, so keyboard tests and readers can see whether a
// button ran.
function Counted({ children }: { children: (press: () => void) => ReactNode }) {
  const [presses, setPresses] = useState(0);
  return (
    <div className="flex flex-col items-start gap-16">
      <div className="flex flex-wrap items-center gap-12">
        {children(() => {
          setPresses((n) => n + 1);
        })}
      </div>
      <output aria-live="polite" className="text-body-s text-secondary" data-numeric>
        Presses: {presses}
      </output>
    </div>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return <div className="p-24 sm:p-48">{children}</div>;
}

const meta = {
  title: 'Components/Button',
  parameters: {
    docs: {
      description: {
        component:
          'Primary, secondary and quiet, at most one primary per view. There is no red button: an undoable delete is an ordinary button followed by an Undo toast. Keyboard: Tab focuses, Enter and Space press. A disabled button stays focusable so its reason can be read, and ignores presses.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const Primary: Story = {
  render: () => (
    <Frame>
      <Counted>
        {(press) => (
          <Button variant="primary" onClick={press}>
            Publish update
          </Button>
        )}
      </Counted>
    </Frame>
  ),
};

export const Secondary: Story = {
  render: () => (
    <Frame>
      <Counted>{(press) => <Button onClick={press}>Save draft</Button>}</Counted>
    </Frame>
  ),
};

export const Quiet: Story = {
  render: () => (
    <Frame>
      <Counted>
        {(press) => (
          <Button variant="quiet" onClick={press}>
            Cancel
          </Button>
        )}
      </Counted>
    </Frame>
  ),
};

// The order a dialog footer or a page header uses: one primary, then the rest.
export const Actions: Story = {
  render: () => (
    <Frame>
      <div className="flex flex-wrap items-center gap-12">
        <Button variant="primary">Publish update</Button>
        <Button>Save draft</Button>
        <Button variant="quiet">Cancel</Button>
        <Button aria-keyshortcuts="N">New incident</Button>
      </div>
    </Frame>
  ),
};

export const Sizes: Story = {
  render: () => (
    <Frame>
      <div className="flex flex-wrap items-center gap-12">
        <Button size="sm">Small</Button>
        <Button size="md">Medium</Button>
        <Button size="lg">Large</Button>
        <Button variant="primary" size="lg">
          Create status page
        </Button>
      </div>
    </Frame>
  ),
};

export const WithIcon: Story = {
  name: 'With icon',
  render: () => (
    <Frame>
      <div className="flex flex-wrap items-center gap-12">
        <Button variant="primary" icon={<IconCheck />}>
          Mark as verified
        </Button>
        <Button icon={<IconCheck />}>Mark as verified</Button>
      </div>
    </Frame>
  ),
};

export const Disabled: Story = {
  tags: ['disabled'],
  render: () => (
    <Frame>
      <Counted>
        {(press) => (
          <>
            <Button variant="primary" disabled aria-describedby="publish-why" onClick={press}>
              Publish update
            </Button>
            <Button disabled aria-describedby="publish-why" onClick={press}>
              Save draft
            </Button>
            <Button variant="quiet" disabled aria-describedby="publish-why" onClick={press}>
              Discard
            </Button>
            <p id="publish-why" className="w-full text-body-s text-secondary">
              Only owners can publish.
            </p>
          </>
        )}
      </Counted>
    </Frame>
  ),
};

// The verb in progress, in the variant's own paint with a progress cursor. No spinner.
export const Busy: Story = {
  tags: ['busy'],
  render: () => (
    <Frame>
      <Counted>
        {(press) => (
          <>
            <Button variant="primary" busy busyLabel="Publishing" onClick={press}>
              Publish update
            </Button>
            <Button busy busyLabel="Saving draft" onClick={press}>
              Save draft
            </Button>
          </>
        )}
      </Counted>
    </Frame>
  ),
};

// Pressing starts the work: the button shows the verb in progress at the same width and the
// region it changes is busy. One busy label is longer than its rest label and one shorter,
// so both directions of the width rule are on screen. The work never finishes here, so the
// state can be read and checked.
function Publishing() {
  const [publishing, setPublishing] = useState(false);
  const [saving, setSaving] = useState(false);
  return (
    <Frame>
      <section aria-labelledby="update" aria-busy={publishing || saving} className="max-w-measure">
        <h2 id="update" className="text-title text-ink">
          Incident update
        </h2>
        <p className="mt-8 text-body-m text-body">
          Payments API is degraded in two regions. We are rolling back the last deploy.
        </p>
      </section>
      <div className="mt-24 flex flex-wrap items-center gap-12">
        <Button
          variant="primary"
          busy={publishing}
          busyLabel="Publishing update"
          onClick={() => {
            setPublishing(true);
          }}
        >
          Publish
        </Button>
        <Button
          busy={saving}
          busyLabel="Saving"
          onClick={() => {
            setSaving(true);
          }}
        >
          Save draft and close
        </Button>
      </div>
    </Frame>
  );
}

export const BecomesBusy: Story = {
  name: 'Becomes busy',
  render: () => <Publishing />,
};

export const Links: Story = {
  render: () => (
    <Frame>
      <div className="flex flex-wrap items-center gap-12">
        <ButtonLink href="#history">View history</ButtonLink>
        <ButtonLink href="#new" variant="primary">
          Create status page
        </ButtonLink>
        <ButtonLink href="https://drefyn.com/docs" target="_blank" variant="quiet">
          Read the docs
        </ButtonLink>
      </div>
      <h2 id="history" className="mt-48 text-title text-ink">
        History
      </h2>
    </Frame>
  ),
};
