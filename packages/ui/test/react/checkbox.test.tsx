import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Checkbox } from '../../src/react/index.ts';
import { classesOf, only } from './classes.ts';

afterEach(cleanup);

const LABEL = 'Email me when a page goes stale';
const box = () => screen.getByRole<HTMLInputElement>('checkbox', { name: LABEL });

const describedBy = (el: HTMLElement) =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');

describe('Checkbox', () => {
  it('is a checkbox named by its visible label, unchecked by default', () => {
    render(<Checkbox>{LABEL}</Checkbox>);
    expect(box().checked).toBe(false);
    expect(screen.getByText(LABEL)).toBeDefined();
  });

  it('is a real checkbox input, so a form posts it without JS', () => {
    render(
      <form aria-label="Alerts">
        <Checkbox name="stale" value="email" defaultChecked>
          {LABEL}
        </Checkbox>
      </form>,
    );
    expect(box().tagName).toBe('INPUT');
    expect(box().type).toBe('checkbox');
    const form = screen.getByRole<HTMLFormElement>('form', { name: 'Alerts' });
    expect(new FormData(form).get('stale')).toBe('email');
  });

  it('toggles on a click on the box or its label and on Space, and reports a boolean', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Checkbox onChange={onChange}>{LABEL}</Checkbox>);
    await user.click(box());
    expect(box().checked).toBe(true);
    await user.click(screen.getByText(LABEL));
    expect(box().checked).toBe(false);
    box().focus();
    await user.keyboard(' ');
    expect(box().checked).toBe(true);
    expect(onChange.mock.calls).toEqual([[true], [false], [true]]);
  });

  it('follows its checked prop when controlled', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Checkbox checked={false} onChange={onChange}>
        {LABEL}
      </Checkbox>,
    );
    await userEvent.setup().click(box());
    expect(onChange).toHaveBeenCalledWith(true);
    expect(box().checked).toBe(false);
    rerender(
      <Checkbox checked onChange={onChange}>
        {LABEL}
      </Checkbox>,
    );
    expect(box().checked).toBe(true);
  });

  it('shows indeterminate as mixed on the input and draws a bar, not a tick', () => {
    render(<Checkbox indeterminate>{LABEL}</Checkbox>);
    expect(box().indeterminate).toBe(true);
    const label = box().closest('label');
    expect(label?.querySelector('[data-mark="bar"]')).not.toBeNull();
    expect(label?.querySelector('[data-mark="tick"]')).toBeNull();
  });

  it('draws a tick only when checked', async () => {
    render(<Checkbox>{LABEL}</Checkbox>);
    const label = () => box().closest('label');
    expect(label()?.querySelector('[data-mark="tick"]')).toBeNull();
    await userEvent.setup().click(box());
    expect(label()?.querySelector('[data-mark="tick"]')).not.toBeNull();
  });

  it('joins its description and error with aria-describedby and marks itself invalid', () => {
    render(
      <Checkbox
        description="We send at most one email a day."
        error="Confirm before you continue."
        required
      >
        {LABEL}
      </Checkbox>,
    );
    expect(describedBy(box())).toContain('We send at most one email a day.');
    expect(describedBy(box())).toContain('Confirm before you continue.');
    expect(box().getAttribute('aria-invalid')).toBe('true');
    expect(box().getAttribute('aria-required')).toBe('true');
  });

  it('leaves validity to the form, so an error never blocks a native submit', () => {
    render(<Checkbox error="Confirm before you continue.">{LABEL}</Checkbox>);
    expect(box().validity.valid).toBe(true);
  });

  it('is not invalid with a blank error', () => {
    render(<Checkbox error="  ">{LABEL}</Checkbox>);
    expect(box().hasAttribute('aria-invalid')).toBe(false);
  });

  it('paints the invalid edge on the box', () => {
    render(<Checkbox error="Confirm before you continue.">{LABEL}</Checkbox>);
    const label = box().closest('label') as HTMLElement;
    expect(classesOf(only(label.querySelectorAll('[data-box]')))).toContain(
      'border-state-broken-mark',
    );
  });

  it('uses DOM names and never the React Aria is* names', () => {
    // @ts-expect-error checked, not isSelected.
    const a = <Checkbox isSelected>{LABEL}</Checkbox>;
    // @ts-expect-error indeterminate, not isIndeterminate.
    const b = <Checkbox isIndeterminate>{LABEL}</Checkbox>;
    // @ts-expect-error disabled, not isDisabled.
    const c = <Checkbox isDisabled>{LABEL}</Checkbox>;
    expect([a, b, c]).toHaveLength(3);
  });
});

describe('a disabled Checkbox', () => {
  it('uses aria-disabled, stays focusable and is not natively disabled', () => {
    render(<Checkbox disabled>{LABEL}</Checkbox>);
    expect(box().getAttribute('aria-disabled')).toBe('true');
    expect(box().disabled).toBe(false);
    box().focus();
    expect(document.activeElement).toBe(box());
  });

  it('ignores clicks, label clicks and Space, and never reports a change', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Checkbox disabled defaultChecked onChange={onChange}>
        {LABEL}
      </Checkbox>,
    );
    await user.click(box());
    await user.click(screen.getByText(LABEL));
    box().focus();
    await user.keyboard(' ');
    expect(box().checked).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('paints the box with the disabled family and never with opacity', () => {
    render(<Checkbox disabled>{LABEL}</Checkbox>);
    const label = box().closest('label') as HTMLElement;
    const drawn = only(label.querySelectorAll('[data-box]'));
    expect(classesOf(drawn)).toEqual(
      expect.arrayContaining(['border-disabled-edge', 'bg-disabled-fill']),
    );
    expect(classesOf(label)).toContain('text-disabled-text');
    for (const el of [label, ...label.querySelectorAll('*')]) {
      expect(classesOf(el).filter((c) => /(^|:)opacity-/.test(c))).toEqual([]);
    }
  });

  it('drops aria-disabled when it turns live', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Checkbox disabled onChange={onChange}>
        {LABEL}
      </Checkbox>,
    );
    rerender(<Checkbox onChange={onChange}>{LABEL}</Checkbox>);
    expect(box().hasAttribute('aria-disabled')).toBe(false);
    await userEvent.setup().click(box());
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
