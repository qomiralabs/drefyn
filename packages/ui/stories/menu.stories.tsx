import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';
import {
  IconChevronDown,
  IconMore,
  Menu,
  MenuItem,
  MenuSection,
  MenuSeparator,
} from '../src/react/index.ts';

const meta = {
  title: 'Components/Menu',
  parameters: {
    docs: {
      description: {
        component:
          'Row actions, the account menu, "more". Keyboard: Enter, Space or ArrowDown opens on the first item, ArrowUp on the last; arrows, Home and End move; typing a letter jumps; Enter runs; Escape and Tab close and focus returns to the trigger. A disabled item stays reachable by the arrows and is announced as unavailable.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

// The last action is written to a live output, so tests and readers see what ran.
function WithOutput({ children }: { children: (run: (id: string) => void) => ReactNode }) {
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

const NAMES: Record<string, string> = {
  open: 'Open monitor',
  incident: 'Start incident',
  hide: 'Hide from audience',
  copy: 'Copy ID',
};

function Actions({ defaultOpen = false }: { defaultOpen?: boolean }) {
  return (
    <WithOutput>
      {(run) => (
        <Menu
          trigger={
            <>
              Payments API
              <IconChevronDown />
            </>
          }
          defaultOpen={defaultOpen}
          onAction={(id) => {
            run(NAMES[id] ?? id);
          }}
        >
          <MenuItem id="open" shortcut="O">
            Open monitor
          </MenuItem>
          <MenuItem id="incident" shortcut="I">
            Start incident
          </MenuItem>
          <MenuItem id="hide" disabled>
            Hide from audience
          </MenuItem>
          <MenuItem id="copy">Copy ID</MenuItem>
        </Menu>
      )}
    </WithOutput>
  );
}

export const Default: Story = {
  render: () => <Actions />,
};

export const Open: Story = {
  tags: ['disabled'],
  render: () => <Actions defaultOpen />,
};

export const Sections: Story = {
  render: () => (
    <WithOutput>
      {(run) => (
        <Menu trigger="View" defaultOpen onAction={run}>
          <MenuSection title="Show">
            <MenuItem id="uptime">Uptime figure</MenuItem>
            <MenuItem id="latency">Latency</MenuItem>
          </MenuSection>
          <MenuSeparator />
          <MenuItem id="reset">Reset view</MenuItem>
        </Menu>
      )}
    </WithOutput>
  ),
};

export const IconTrigger: Story = {
  name: 'Icon trigger',
  render: () => (
    <WithOutput>
      {(run) => (
        <Menu
          trigger={<IconMore />}
          triggerLabel="Actions for Checkout"
          variant="quiet"
          size="sm"
          onAction={run}
        >
          <MenuItem id="open">Open monitor</MenuItem>
          <MenuItem id="copy">Copy ID</MenuItem>
        </Menu>
      )}
    </WithOutput>
  ),
};
