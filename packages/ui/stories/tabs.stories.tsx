import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { Button, EmptyState, Skeleton, Tab, TabList, TabPanel, Tabs } from '../src/react/index.ts';

const meta = {
  title: 'Components/Tabs',
  parameters: {
    docs: {
      description: {
        component:
          'Views of one thing that share a place on the page, such as the pages of a site and the ones out of date. Tabs that change the address are links in a nav, not tabs. Keyboard: Tab enters on the selected tab and Tab again moves into its panel; the left and right arrows, Home and End move between tabs. With automatic activation a panel shows as the arrows reach its tab; with manual activation, for panels that fetch, Enter or Space shows it. A disabled tab stays reachable by the arrows and is announced as unavailable, but is never shown. A newly shown panel fades in; nothing slides.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="flex max-w-measure flex-col gap-16 p-24 sm:p-48">{children}</div>
);

const Panel = ({ children }: { children: ReactNode }) => (
  <p className="pt-16 text-body-s text-body">{children}</p>
);

export const Default: Story = {
  render: () => (
    <Frame>
      <Tabs>
        <TabList label="Site views">
          <Tab value="pages">Pages</Tab>
          <Tab value="stale">Out of date</Tab>
          <Tab value="history">History</Tab>
        </TabList>
        <TabPanel value="pages">
          <Panel>Every page on the site, newest first.</Panel>
        </TabPanel>
        <TabPanel value="stale">
          <Panel>Pages the agent flagged since the last publish.</Panel>
        </TabPanel>
        <TabPanel value="history">
          <Panel>Every publish, with who approved it.</Panel>
        </TabPanel>
      </Tabs>
    </Frame>
  ),
};

export const WithCounts: Story = {
  name: 'With counts',
  render: () => (
    <Frame>
      <Tabs defaultValue="stale">
        <TabList label="Site views">
          <Tab value="pages" count={1284}>
            Pages
          </Tab>
          <Tab value="stale" count={12}>
            Out of date
          </Tab>
          <Tab value="drafts" count={3}>
            Drafts
          </Tab>
        </TabList>
        <TabPanel value="pages">
          <Panel>1,284 pages.</Panel>
        </TabPanel>
        <TabPanel value="stale">
          <Panel>12 pages are out of date. The oldest changed 9 days ago.</Panel>
        </TabPanel>
        <TabPanel value="drafts">
          <Panel>3 drafts wait for review.</Panel>
        </TabPanel>
      </Tabs>
    </Frame>
  ),
};

export const Manual: Story = {
  render: () => (
    <Frame>
      <Tabs activation="manual">
        <TabList label="Incident views">
          <Tab value="timeline">Timeline</Tab>
          <Tab value="affected">Affected components</Tab>
          <Tab value="subscribers">Subscribers</Tab>
        </TabList>
        <TabPanel value="timeline">
          <Panel>Updates in the order they were posted.</Panel>
        </TabPanel>
        <TabPanel value="affected">
          <Panel>Components this incident marks as degraded.</Panel>
        </TabPanel>
        <TabPanel value="subscribers">
          <Panel>People who get an email for each update.</Panel>
        </TabPanel>
      </Tabs>
    </Frame>
  ),
};

export const Disabled: Story = {
  tags: ['disabled'],
  render: () => (
    <Frame>
      <Tabs>
        <TabList label="Site views">
          <Tab value="pages">Pages</Tab>
          <Tab value="drafts" disabled>
            Drafts
          </Tab>
          <Tab value="history">History</Tab>
        </TabList>
        <TabPanel value="pages">
          <Panel>Drafts open once the site has a reviewer.</Panel>
        </TabPanel>
        <TabPanel value="drafts">
          <Panel>Drafts waiting for review.</Panel>
        </TabPanel>
        <TabPanel value="history">
          <Panel>Every publish, with who approved it.</Panel>
        </TabPanel>
      </Tabs>
    </Frame>
  ),
};

export const LoadingPanel: Story = {
  name: 'Loading panel',
  render: () => (
    <Frame>
      <Tabs>
        <TabList label="Site views">
          <Tab value="pages">Pages</Tab>
          <Tab value="history">History</Tab>
        </TabList>
        <TabPanel value="pages">
          <div className="flex flex-col gap-12 pt-16" aria-busy="true">
            <Skeleton width="3/4" />
            <Skeleton width="1/2" />
            <Skeleton width="3/4" />
          </div>
        </TabPanel>
        <TabPanel value="history">
          <Panel>Every publish, with who approved it.</Panel>
        </TabPanel>
      </Tabs>
    </Frame>
  ),
};

export const EmptyPanel: Story = {
  name: 'Empty panel',
  render: () => (
    <Frame>
      <Tabs defaultValue="stale">
        <TabList label="Site views">
          <Tab value="pages" count={128}>
            Pages
          </Tab>
          <Tab value="stale" count={0}>
            Out of date
          </Tab>
        </TabList>
        <TabPanel value="pages">
          <Panel>Every page on the site, newest first.</Panel>
        </TabPanel>
        <TabPanel value="stale">
          <div className="pt-16">
            <EmptyState
              title="Nothing out of date"
              headingLevel={3}
              action={<Button size="sm">View all pages</Button>}
            >
              Every page matches the code it describes.
            </EmptyState>
          </div>
        </TabPanel>
      </Tabs>
    </Frame>
  ),
};
