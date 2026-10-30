import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { Tab, TabList, TabPanel, Tabs } from '../../src/react/index.ts';
import { classesOf } from './classes.ts';

afterEach(cleanup);

type Props = Omit<ComponentProps<typeof Tabs>, 'children'>;

function Views(props: Props) {
  return (
    <Tabs {...props}>
      <TabList label="Site views">
        <Tab value="pages" count={128}>
          Pages
        </Tab>
        <Tab value="stale" count={12}>
          Out of date
        </Tab>
        <Tab value="drafts" disabled>
          Drafts
        </Tab>
        <Tab value="history">History</Tab>
      </TabList>
      <TabPanel value="pages">Every page on the site.</TabPanel>
      <TabPanel value="stale">Pages the agent flagged.</TabPanel>
      <TabPanel value="drafts">Drafts waiting for review.</TabPanel>
      <TabPanel value="history">Every publish, newest first.</TabPanel>
    </Tabs>
  );
}

const tab = (name: RegExp) => screen.getByRole('tab', { name });
const shown = () => screen.getByRole('tabpanel').textContent;

describe('Tabs', () => {
  it('is a tab list named by its label, the first tab selected and its panel shown', () => {
    render(<Views />);
    expect(screen.getByRole('tablist', { name: 'Site views' })).toBeDefined();
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(tab(/^Pages/).getAttribute('aria-selected')).toBe('true');
    expect(shown()).toBe('Every page on the site.');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tab(/^Pages/).id);
  });

  it('shows a count in tabular figures after the label', () => {
    render(<Views />);
    const count = tab(/^Pages/).querySelector('[data-numeric]');
    expect(count?.textContent).toBe('128');
  });

  it('selects on a click and reports the value, not an event', async () => {
    const onChange = vi.fn();
    render(<Views onChange={onChange} />);
    await userEvent.setup().click(tab(/^Out of date/));
    expect(tab(/^Out of date/).getAttribute('aria-selected')).toBe('true');
    expect(shown()).toBe('Pages the agent flagged.');
    expect(onChange.mock.calls).toEqual([['stale']]);
  });

  it('moves and selects with the arrow keys, Home and End when automatic', async () => {
    const user = userEvent.setup();
    render(<Views />);
    tab(/^Pages/).focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(tab(/^Out of date/));
    expect(shown()).toBe('Pages the agent flagged.');
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(tab(/^History/));
    expect(shown()).toBe('Every publish, newest first.');
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(tab(/^Pages/));
  });

  it('waits for Enter or Space before showing a panel when manual', async () => {
    const user = userEvent.setup();
    render(<Views activation="manual" />);
    tab(/^Pages/).focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(tab(/^Out of date/));
    expect(shown()).toBe('Every page on the site.');
    await user.keyboard('{Enter}');
    expect(shown()).toBe('Pages the agent flagged.');
  });

  it('starts on defaultValue and follows value when controlled', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<Views value="history" onChange={onChange} />);
    expect(shown()).toBe('Every publish, newest first.');
    await userEvent.setup().click(tab(/^Pages/));
    expect(onChange).toHaveBeenCalledWith('pages');
    expect(shown()).toBe('Every publish, newest first.');
    rerender(<Views value="pages" onChange={onChange} />);
    expect(shown()).toBe('Every page on the site.');
    cleanup();
    render(<Views defaultValue="stale" />);
    expect(shown()).toBe('Pages the agent flagged.');
  });

  it('marks the selected tab with the indicator and ink, the others secondary', () => {
    render(<Views />);
    expect(classesOf(tab(/^Pages/))).toEqual(expect.arrayContaining(['text-ink', 'font-medium']));
    expect(tab(/^Pages/).querySelector('[data-indicator]')).not.toBeNull();
    expect(classesOf(tab(/^History/))).toContain('text-secondary');
  });

  it('fades a newly shown panel in, never moving it', async () => {
    render(<Views />);
    await userEvent.setup().click(tab(/^History/));
    const classes = classesOf(screen.getByRole('tabpanel'));
    expect(classes).toEqual(expect.arrayContaining(['transition-opacity', 'duration-base']));
    expect(classes.filter((c) => /translate|transition-all|^transition$/.test(c))).toEqual([]);
  });

  it('needs a label for its tab list', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() =>
      render(
        <Tabs>
          <TabList label="">
            <Tab value="a">A</Tab>
          </TabList>
          <TabPanel value="a">A</TabPanel>
        </Tabs>,
      ),
    ).toThrow(/label/);
  });

  it('uses DOM names and never the React Aria ones', () => {
    // @ts-expect-error value, not selectedKey.
    const a = <Tabs selectedKey="pages">x</Tabs>;
    // @ts-expect-error onChange, not onSelectionChange.
    const b = <Tabs onSelectionChange={() => undefined}>x</Tabs>;
    const c = (
      // @ts-expect-error disabled, not isDisabled.
      <Tab value="pages" isDisabled>
        Pages
      </Tab>
    );
    expect([a, b, c]).toHaveLength(3);
  });
});

describe('a disabled Tab', () => {
  it('is reached by the arrow keys with aria-disabled, but never selected', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Views defaultValue="stale" onChange={onChange} />);
    tab(/^Out of date/).focus();
    await user.keyboard('{ArrowRight}');
    const drafts = tab(/^Drafts/);
    expect(document.activeElement).toBe(drafts);
    expect(drafts.getAttribute('aria-disabled')).toBe('true');
    expect(drafts.getAttribute('aria-selected')).not.toBe('true');
    expect(shown()).toBe('Pages the agent flagged.');
    await user.keyboard('{Enter}');
    await user.click(drafts);
    expect(shown()).toBe('Pages the agent flagged.');
    expect(onChange).not.toHaveBeenCalled();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(tab(/^History/));
  });

  it('paints with the disabled text and never with opacity', () => {
    render(<Views />);
    const drafts = tab(/^Drafts/);
    expect(classesOf(drafts)).toContain('text-disabled-text');
    for (const el of [drafts, ...drafts.querySelectorAll('*')]) {
      expect(classesOf(el).filter((c) => /(^|:)opacity-/.test(c))).toEqual([]);
    }
  });

  it('is never chosen as the first tab', () => {
    render(
      <Tabs>
        <TabList label="Site views">
          <Tab value="drafts" disabled>
            Drafts
          </Tab>
          <Tab value="pages">Pages</Tab>
        </TabList>
        <TabPanel value="drafts">Drafts waiting for review.</TabPanel>
        <TabPanel value="pages">Every page on the site.</TabPanel>
      </Tabs>,
    );
    expect(shown()).toBe('Every page on the site.');
  });
});
