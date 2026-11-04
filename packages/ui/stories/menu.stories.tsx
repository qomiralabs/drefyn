import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';
import {
  Button,
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
          'Row actions, the account menu, "more". Keyboard: Enter, Space or ArrowDown opens on the first item, ArrowUp on the last; arrows, Home and End move; typing a letter jumps; Enter runs; Escape closes and returns focus to the trigger; Tab and Shift+Tab close and move on from the trigger, as they would if the menu were closed. A disabled item stays reachable by the arrows, is announced as unavailable and reads its reason. Below 640 px the menu opens in a bottom sheet titled by the trigger, with 40 px rows; Escape, a press on the scrim and Close shut it and return focus to the trigger. Stories that start open do so only in their own view, so this page stays readable.',
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
          <MenuItem id="hide" disabled reason="Only an owner can hide a component">
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

// A menu that starts open is modal: it would cover this docs page, lock its scroll and hide
// the rest from screen readers. So it starts open only in its own story view.
const openInStoryView = (context?: { viewMode?: string }) => context?.viewMode !== 'docs';

export const Open: Story = {
  tags: ['disabled'],
  render: (_args, context) => <Actions defaultOpen={openInStoryView(context)} />,
};

export const Sections: Story = {
  render: (_args, context) => (
    <WithOutput>
      {(run) => (
        <Menu trigger="View" defaultOpen={openInStoryView(context)} onAction={run}>
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

// The account menu: initials on a round trigger. The edge, the hover fill and the open fill
// all follow the circle. MW is about the widest pair, so it shows the tightest fit.
function Account({ open }: { open: boolean }) {
  return (
    <WithOutput>
      {(run) => (
        <div className="flex items-center gap-12">
          {[
            ['MO', 'Maya Okafor'],
            ['MW', 'Mei Wong'],
          ].map(([initials = '', name = '']) => (
            <Menu
              key={initials}
              trigger={<span className="text-caption font-medium text-secondary">{initials}</span>}
              triggerLabel={`${initials}, account for ${name}`}
              triggerShape="round"
              defaultOpen={open && initials === 'MO'}
              onAction={run}
            >
              <MenuItem id="profile">Profile and security</MenuItem>
              <MenuItem id="sign-out">Sign out</MenuItem>
            </Menu>
          ))}
        </div>
      )}
    </WithOutput>
  );
}

export const RoundTrigger: Story = {
  name: 'Round trigger',
  render: () => <Account open={false} />,
};

export const RoundTriggerOpen: Story = {
  name: 'Round trigger open',
  render: (_args, context) => <Account open={openInStoryView(context)} />,
};

// A menu between other controls, so the specs can check where Tab and Shift+Tab land.
export const InARow: Story = {
  name: 'In a row',
  render: () => (
    <WithOutput>
      {(run) => (
        <div className="flex flex-wrap items-center gap-12">
          <Button>Edit component</Button>
          <Menu
            trigger={
              <>
                Payments API
                <IconChevronDown />
              </>
            }
            onAction={(id) => {
              run(NAMES[id] ?? id);
            }}
          >
            <MenuItem id="open">Open monitor</MenuItem>
            <MenuItem id="copy">Copy ID</MenuItem>
          </Menu>
          <Button>Share page</Button>
        </div>
      )}
    </WithOutput>
  ),
};

// A filter: the menu stays open while several are chosen, and each item says how many rows it
// would keep. Sort is the single choice form, which closes on the first press.
function RoleFilter() {
  const [roles, setRoles] = useState<string[]>(['member']);
  return (
    <Menu trigger="Role" selectionMode="multiple" selected={roles} onSelectionChange={setRoles}>
      <MenuItem id="owner" meta="1">
        Owner
      </MenuItem>
      <MenuItem id="admin" meta="1">
        Admin
      </MenuItem>
      <MenuItem id="member" meta="2">
        Member
      </MenuItem>
    </Menu>
  );
}

export const Filter: Story = { render: () => <RoleFilter /> };
