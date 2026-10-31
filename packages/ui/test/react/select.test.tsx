import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { Button, Select, SelectOption } from '../../src/react/index.ts';
import { classesOf } from './classes.ts';

afterEach(cleanup);

type Props = Omit<ComponentProps<typeof Select>, 'label' | 'children'>;

function Region(props: Props) {
  return (
    <Select label="Region" placeholder="Choose a region" {...props}>
      <SelectOption value="eu" description="Frankfurt and Dublin">
        Europe
      </SelectOption>
      <SelectOption value="us">United States</SelectOption>
      <SelectOption value="ap" disabled>
        Asia Pacific
      </SelectOption>
      <SelectOption value="sa">South America</SelectOption>
    </Select>
  );
}

const trigger = () => screen.getByRole('button', { name: /Region/ });
const listbox = () => screen.getByRole('listbox');
const option = (name: string | RegExp) => screen.getByRole('option', { name });
const describedBy = (el: HTMLElement) =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');

describe('Select', () => {
  it('starts closed on a trigger named by its label that shows the placeholder', () => {
    render(<Region />);
    expect(trigger().textContent).toContain('Choose a region');
    expect(trigger().getAttribute('aria-expanded')).not.toBe('true');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByText('Region')).toBeDefined();
  });

  it('opens a listbox of every option on a click', async () => {
    render(<Region />);
    await userEvent.setup().click(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(
      within(listbox())
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([
      expect.stringContaining('Europe'),
      'United States',
      'Asia Pacific',
      'South America',
    ]);
  });

  it('chooses an option, closes, shows it on the trigger and reports the value', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Region onChange={onChange} />);
    await user.click(trigger());
    await user.click(option('United States'));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger().textContent).toContain('United States');
    expect(onChange.mock.calls).toEqual([['us']]);
  });

  it('marks the chosen option selected with a tick and no wash', async () => {
    const user = userEvent.setup();
    render(<Region defaultValue="eu" />);
    await user.click(trigger());
    const chosen = option(/Europe/);
    expect(chosen.getAttribute('aria-selected')).toBe('true');
    expect(chosen.querySelector('[data-icon="check"]')).not.toBeNull();
    expect(classesOf(chosen).some((c) => c.includes('accent-wash'))).toBe(false);
    expect(option('United States').querySelector('[data-icon="check"]')).toBeNull();
  });

  it('joins an option description to the option', async () => {
    render(<Region />);
    await userEvent.setup().click(trigger());
    expect(describedBy(option(/Europe/))).toContain('Frankfurt and Dublin');
  });

  it('posts the chosen value under its name', () => {
    render(
      <form aria-label="Site">
        <Region name="region" defaultValue="sa" />
      </form>,
    );
    const form = screen.getByRole<HTMLFormElement>('form', { name: 'Site' });
    expect(new FormData(form).get('region')).toBe('sa');
  });

  it('follows its value prop when controlled', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<Region value="eu" onChange={onChange} />);
    await user.click(trigger());
    await user.click(option('United States'));
    expect(onChange).toHaveBeenCalledWith('us');
    expect(trigger().textContent).toContain('Europe');
    rerender(<Region value="us" onChange={onChange} />);
    expect(trigger().textContent).toContain('United States');
  });

  it('joins its description and error to the trigger and marks itself invalid', () => {
    render(
      <Region
        description="Pages are served from here."
        error="Choose a region to create the site."
      />,
    );
    expect(describedBy(trigger())).toContain('Pages are served from here.');
    expect(describedBy(trigger())).toContain('Choose a region to create the site.');
    expect(classesOf(trigger())).toContain('border-state-broken-mark');
  });

  it('closes on Escape and gives focus back to the trigger', async () => {
    const user = userEvent.setup();
    render(<Region />);
    trigger().focus();
    await user.keyboard('{Enter}');
    expect(listbox()).toBeDefined();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('styles its trigger as a field, not as a button', () => {
    render(
      <>
        <Region />
        <Button variant="secondary">Plain</Button>
      </>,
    );
    expect(classesOf(trigger())).toEqual(
      expect.arrayContaining(['border-control', 'bg-ground', 'h-control-md']),
    );
  });

  it('shows skeleton rows and marks the list busy while loading', async () => {
    render(
      <Select label="Region" loading>
        {[]}
      </Select>,
    );
    await userEvent.setup().click(trigger());
    expect(listbox().getAttribute('aria-busy')).toBe('true');
    expect(listbox().querySelectorAll('[data-skeleton]').length).toBe(3);
    // React Aria wraps an empty list's content in one option, so the reader hears the wait.
    const waiting = within(listbox()).getAllByRole('option');
    expect(waiting.map((o) => o.textContent)).toEqual(['Loading options']);
    expect(waiting[0]?.hasAttribute('aria-selected')).toBe(false);
  });

  it('refuses an empty list that is not loading', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Select label="Region">{[]}</Select>)).toThrow(/option/);
  });

  it('needs a visible label', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() =>
      render(
        <Select label="">
          <SelectOption value="eu">Europe</SelectOption>
        </Select>,
      ),
    ).toThrow(/label/);
  });

  it('uses DOM names and never the React Aria ones', () => {
    // @ts-expect-error value, not selectedKey.
    const a = <Select label="Region" selectedKey="eu" />;
    // @ts-expect-error disabled, not isDisabled.
    const b = <Select label="Region" isDisabled />;
    // @ts-expect-error SelectOption text only.
    const c = <SelectOption value="eu">{<b>Europe</b>}</SelectOption>;
    expect([a, b, c]).toHaveLength(3);
  });
});

// Arrow key travel through a disabled option is proven in the browser specs: happy-dom puts
// focus on the popover instead of the list, which no engine does.
describe('a disabled option', () => {
  it('is announced as unavailable and never chosen by a press or Enter', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Region onChange={onChange} />);
    await user.click(trigger());
    const ap = option('Asia Pacific');
    expect(ap.getAttribute('aria-disabled')).toBe('true');
    expect(option(/Europe/).hasAttribute('aria-disabled')).toBe(false);
    await user.click(ap);
    ap.focus();
    await user.keyboard('{Enter}');
    expect(listbox()).toBeDefined();
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger().textContent).toContain('Choose a region');
  });

  it('paints with the disabled text and takes no hover fill', async () => {
    render(<Region />);
    await userEvent.setup().click(trigger());
    const classes = classesOf(option('Asia Pacific'));
    expect(classes).toContain('text-disabled-text');
    expect(classes.filter((c) => c.includes('bg-hover') || /(^|:)opacity-/.test(c))).toEqual([]);
  });
});

describe('a disabled Select', () => {
  it('stays focusable with aria-disabled, never opens and never changes', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Region disabled defaultValue="eu" onChange={onChange} />);
    expect(trigger().getAttribute('aria-disabled')).toBe('true');
    expect((trigger() as HTMLButtonElement).disabled).toBe(false);
    trigger().focus();
    expect(document.activeElement).toBe(trigger());
    await user.click(trigger());
    await user.keyboard('{Enter}{ArrowDown} u');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger().textContent).toContain('Europe');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('paints the trigger with the disabled family and never with opacity', () => {
    render(<Region disabled />);
    expect(classesOf(trigger())).toEqual(
      expect.arrayContaining(['border-disabled-edge', 'bg-disabled-fill', 'text-disabled-text']),
    );
    for (const el of [trigger(), ...trigger().querySelectorAll('*')]) {
      expect(classesOf(el).filter((c) => /(^|:)opacity-/.test(c))).toEqual([]);
    }
  });

  it('opens again once disabled is dropped', async () => {
    const { rerender } = render(<Region disabled />);
    rerender(<Region />);
    expect(trigger().hasAttribute('aria-disabled')).toBe(false);
    await userEvent.setup().click(trigger());
    expect(listbox()).toBeDefined();
  });
});
