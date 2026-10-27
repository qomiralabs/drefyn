import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Switch } from '../../src/react/index.ts';

afterEach(cleanup);

const LABEL = 'Show uptime figure';
const toggle = () => screen.getByRole('switch', { name: LABEL });
const isOn = () => (toggle() as HTMLInputElement).checked;

describe('Switch', () => {
  it('is a switch named by its visible label, off by default', () => {
    render(<Switch>{LABEL}</Switch>);
    expect(toggle()).toBeDefined();
    expect(isOn()).toBe(false);
    expect(screen.getByText(LABEL)).toBeDefined();
  });

  it('is a real checkbox input, so a form posts it without JS', () => {
    render(
      <form aria-label="Settings">
        <Switch name="uptime" defaultChecked>
          {LABEL}
        </Switch>
      </form>,
    );
    const input = toggle() as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
    expect(input.type).toBe('checkbox');
    const form = screen.getByRole<HTMLFormElement>('form', { name: 'Settings' });
    expect(new FormData(form).get('uptime')).toBe('on');
  });

  it('posts its value when on and nothing when off', async () => {
    render(
      <form aria-label="Settings">
        <Switch name="agree" value="two-regions">
          {LABEL}
        </Switch>
      </form>,
    );
    const form = screen.getByRole<HTMLFormElement>('form', { name: 'Settings' });
    expect(new FormData(form).has('agree')).toBe(false);
    await userEvent.setup().click(toggle());
    expect(new FormData(form).get('agree')).toBe('two-regions');
  });

  it('flips on a click on the switch or its label and reports the new state', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Switch onChange={onChange}>{LABEL}</Switch>);
    await user.click(toggle());
    expect(isOn()).toBe(true);
    await user.click(screen.getByText(LABEL));
    expect(isOn()).toBe(false);
    expect(onChange.mock.calls).toEqual([[true], [false]]);
  });

  it('flips on Space and not on Enter, which a checkbox in a form leaves to submit', async () => {
    const user = userEvent.setup();
    render(<Switch>{LABEL}</Switch>);
    toggle().focus();
    await user.keyboard('{Enter}');
    expect(isOn()).toBe(false);
    await user.keyboard(' ');
    expect(isOn()).toBe(true);
  });

  it('reports a boolean, not an event', async () => {
    const onChange = vi.fn();
    render(<Switch onChange={onChange}>{LABEL}</Switch>);
    await userEvent.setup().click(toggle());
    expect(onChange.mock.calls).toEqual([[true]]);
    expect(typeof onChange.mock.calls[0]?.[0]).toBe('boolean');
  });

  it('uses DOM names and never the React Aria is* names', () => {
    // @ts-expect-error checked, not isSelected.
    const a = <Switch isSelected>{LABEL}</Switch>;
    // @ts-expect-error disabled, not isDisabled.
    const b = <Switch isDisabled>{LABEL}</Switch>;
    // @ts-expect-error defaultChecked, not defaultSelected.
    const c = <Switch defaultSelected>{LABEL}</Switch>;
    expect([a, b, c]).toHaveLength(3);
  });

  it('follows its checked prop when controlled', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <Switch checked={false} onChange={onChange}>
        {LABEL}
      </Switch>,
    );
    await user.click(toggle());
    expect(onChange).toHaveBeenCalledWith(true);
    expect(isOn()).toBe(false);
    rerender(
      <Switch checked onChange={onChange}>
        {LABEL}
      </Switch>,
    );
    expect(isOn()).toBe(true);
  });

  it('flips back when an optimistic change fails', async () => {
    function Optimistic() {
      const [on, setOn] = useState(false);
      return (
        <Switch
          checked={on}
          onChange={(next) => {
            setOn(next);
            // The request failed: the caller puts it back and a toast says why.
            setOn(!next);
          }}
        >
          {LABEL}
        </Switch>
      );
    }
    render(<Optimistic />);
    await userEvent.setup().click(toggle());
    expect(isOn()).toBe(false);
  });

  it('joins its description with aria-describedby', () => {
    render(<Switch description="Shows the 90 day figure under each component.">{LABEL}</Switch>);
    const ids = (toggle().getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
    expect(ids.length).toBeGreaterThan(0);
    const text = ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    expect(text).toContain('Shows the 90 day figure under each component.');
  });
});

describe('a disabled Switch', () => {
  it('uses aria-disabled, stays focusable and is not natively disabled', () => {
    render(<Switch disabled>{LABEL}</Switch>);
    const input = toggle() as HTMLInputElement;
    expect(input.getAttribute('aria-disabled')).toBe('true');
    expect(input.disabled).toBe(false);
    input.focus();
    expect(document.activeElement).toBe(input);
  });

  it('ignores clicks, label clicks and Space, and never reports a change', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Switch disabled defaultChecked onChange={onChange}>
        {LABEL}
      </Switch>,
    );
    await user.click(toggle());
    await user.click(screen.getByText(LABEL));
    toggle().focus();
    await user.keyboard(' ');
    expect(isOn()).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });
});
