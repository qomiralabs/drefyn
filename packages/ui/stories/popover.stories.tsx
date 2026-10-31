import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';
import {
  Button,
  IconMore,
  Popover,
  Select,
  SelectOption,
  Skeleton,
  Switch,
} from '../src/react/index.ts';

const meta = {
  title: 'Components/Popover',
  parameters: {
    docs: {
      description: {
        component:
          'Rich content that floats by its trigger and leaves the page usable: filters, the inbox, the detail behind a freshness badge. It is not modal, so the rest of the page stays readable. For a task that needs input and a Save button, use a Dialog. Keyboard: Enter or Space opens and moves focus into the panel, which reads its heading; Tab moves through the panel; Tab past the last control closes it and moves on from the trigger, and Shift+Tab before the first closes it on the trigger; Escape or a press outside closes it and returns focus to the trigger; a press inside a list it opened, such as the list of a select, is not outside. Use a popover for a panel with a title or controls; short read only text belongs in a Tooltip. Stories that start open do so only in their own view, so this page stays readable.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="flex min-h-128 flex-wrap items-start gap-12 p-24 sm:p-48">{children}</div>
);

// An open popover takes focus, and a docs page full of them would fight over it. So it
// starts open only in its own story view.
const openInStoryView = (context?: { viewMode?: string }) => context?.viewMode !== 'docs';

function Filters({ defaultOpen = false }: { defaultOpen?: boolean }) {
  return (
    <Popover trigger="Filters" title="Filter pages" defaultOpen={defaultOpen}>
      <div className="flex w-shell-nav flex-col gap-16">
        <Switch defaultChecked>Only stale pages</Switch>
        <Switch>Only pages with drafts</Switch>
      </div>
    </Popover>
  );
}

export const Default: Story = {
  render: () => (
    <Frame>
      <Filters />
    </Frame>
  ),
};

export const Open: Story = {
  render: (_args, context) => (
    <Frame>
      <Filters defaultOpen={openInStoryView(context)} />
    </Frame>
  ),
};

export const Loading: Story = {
  render: (_args, context) => (
    <Frame>
      <Popover trigger="Inbox" title="Inbox" defaultOpen={openInStoryView(context)}>
        <ul className="flex w-shell-nav flex-col gap-12" aria-busy="true" aria-label="Messages">
          {(['3/4', '1/2', '3/4'] as const).map((width, i) => (
            <li key={i} className="flex flex-col gap-8">
              <Skeleton width={width} />
              <Skeleton width="1/4" />
            </li>
          ))}
        </ul>
      </Popover>
    </Frame>
  ),
};

export const Failed: Story = {
  render: (_args, context) => (
    <Frame>
      <Popover trigger="Inbox" title="Inbox" defaultOpen={openInStoryView(context)}>
        <div className="flex w-shell-nav flex-col items-start gap-12">
          <p className="text-body-s text-body">Could not load your inbox.</p>
          <Button size="sm">Try again</Button>
        </div>
      </Popover>
    </Frame>
  ),
};

export const IconTrigger: Story = {
  name: 'Icon trigger',
  render: () => (
    <Frame>
      <Popover
        trigger={<IconMore />}
        triggerLabel="Page details"
        variant="quiet"
        size="sm"
        placement="bottom start"
      >
        <dl className="grid w-shell-nav grid-cols-2 gap-8 text-body-s">
          <dt className="text-secondary">Verified</dt>
          <dd className="text-body">2 days ago</dd>
          <dt className="text-secondary">Source</dt>
          <dd className="text-body">docs/billing.md</dd>
        </dl>
      </Popover>
    </Frame>
  ),
};

// A popover between other controls, so the specs can check where Tab and Shift+Tab land.
export const InARow: Story = {
  name: 'In a row',
  render: () => (
    <Frame>
      <Button>Edit page</Button>
      <Filters />
      <Button>Share page</Button>
    </Frame>
  ),
};

// A select inside the panel: its list opens in its own layer, and choosing from it with the
// pointer must keep the panel open.
function WithSelectPanel() {
  const [region, setRegion] = useState('none');
  return (
    <Frame>
      <div className="flex flex-col items-start gap-16">
        <Popover trigger="Filters" title="Filter pages">
          <div className="flex w-shell-nav flex-col gap-16">
            <Select label="Region" placeholder="Any region" onChange={setRegion}>
              <SelectOption value="eu">Europe</SelectOption>
              <SelectOption value="us">United States</SelectOption>
            </Select>
            <Switch>Only stale pages</Switch>
          </div>
        </Popover>
        <output aria-live="polite" className="text-body-s text-secondary">
          Region: {region}
        </output>
      </div>
    </Frame>
  );
}

export const WithSelect: Story = {
  name: 'With a select',
  render: () => <WithSelectPanel />,
};
