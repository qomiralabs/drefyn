import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { Radio, RadioGroup } from '../../src/react/index.ts';
import { classesOf, only } from './classes.ts';

afterEach(cleanup);

type Props = Omit<ComponentProps<typeof RadioGroup>, 'label' | 'children'>;

function Roles(props: Props & { viewerDisabled?: boolean }) {
  const { viewerDisabled = false, ...rest } = props;
  return (
    <RadioGroup label="Role" {...rest}>
      <Radio value="owner" description="Can change billing and delete the site.">
        Owner
      </Radio>
      <Radio value="editor">Editor</Radio>
      <Radio value="viewer" disabled={viewerDisabled}>
        Viewer
      </Radio>
    </RadioGroup>
  );
}

const group = () => screen.getByRole('radiogroup', { name: 'Role' });
const radio = (name: string) => screen.getByRole<HTMLInputElement>('radio', { name });
const chosen = () =>
  screen
    .getAllByRole<HTMLInputElement>('radio')
    .filter((r) => r.checked)
    .map((r) => r.value);

const describedBy = (el: HTMLElement) =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');

describe('RadioGroup', () => {
  it('is a radio group named by its visible label, with a native radio per option', () => {
    render(<Roles />);
    expect(group()).toBeDefined();
    expect(screen.getByText('Role')).toBeDefined();
    for (const name of ['Owner', 'Editor', 'Viewer']) {
      expect(radio(name).tagName).toBe('INPUT');
      expect(radio(name).type).toBe('radio');
    }
    expect(chosen()).toEqual([]);
  });

  it('posts the chosen value under its name without JS', () => {
    render(
      <form aria-label="Invite">
        <Roles name="role" defaultValue="editor" />
      </form>,
    );
    const form = screen.getByRole<HTMLFormElement>('form', { name: 'Invite' });
    expect(new FormData(form).get('role')).toBe('editor');
  });

  it('chooses on a click and reports the value, not an event', async () => {
    const onChange = vi.fn();
    render(<Roles onChange={onChange} />);
    await userEvent.setup().click(radio('Editor'));
    expect(chosen()).toEqual(['editor']);
    expect(onChange.mock.calls).toEqual([['editor']]);
  });

  it('moves and chooses with the arrow keys', async () => {
    const user = userEvent.setup();
    render(<Roles defaultValue="owner" />);
    radio('Owner').focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(radio('Editor'));
    expect(chosen()).toEqual(['editor']);
  });

  it('follows its value prop when controlled', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<Roles value="owner" onChange={onChange} />);
    await userEvent.setup().click(radio('Editor'));
    expect(onChange).toHaveBeenCalledWith('editor');
    expect(chosen()).toEqual(['owner']);
    rerender(<Roles value="editor" onChange={onChange} />);
    expect(chosen()).toEqual(['editor']);
  });

  it('joins the group description and error to the group and marks it invalid', () => {
    render(
      <Roles description="You can change this later." error="Choose a role to send the invite." />,
    );
    expect(describedBy(group())).toContain('You can change this later.');
    expect(describedBy(group())).toContain('Choose a role to send the invite.');
    expect(group().getAttribute('aria-invalid')).toBe('true');
  });

  it('joins a radio description to that radio only', () => {
    render(<Roles />);
    expect(describedBy(radio('Owner'))).toContain('Can change billing and delete the site.');
    expect(describedBy(radio('Editor'))).not.toContain('Can change billing');
  });

  it('leaves validity to the form, so an error never blocks a native submit', () => {
    render(<Roles required error="Choose a role to send the invite." />);
    for (const r of screen.getAllByRole<HTMLInputElement>('radio')) {
      expect(r.validity.customError).toBe(false);
    }
  });

  it('needs a visible label', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() =>
      render(
        <RadioGroup label=" ">
          <Radio value="a">A</Radio>
        </RadioGroup>,
      ),
    ).toThrow(/label/);
  });

  it('lays out in a row when horizontal', () => {
    render(<Roles orientation="horizontal" />);
    expect(group().getAttribute('aria-orientation')).toBe('horizontal');
  });

  it('uses DOM names and never the React Aria is* names', () => {
    // @ts-expect-error disabled, not isDisabled.
    const a = <RadioGroup label="Role" isDisabled />;
    // @ts-expect-error onChange, not onSelectionChange.
    const b = <RadioGroup label="Role" onSelectionChange={() => undefined} />;
    expect([a, b]).toHaveLength(2);
  });
});

describe('a disabled Radio', () => {
  it('stays focusable with aria-disabled and is not natively disabled', () => {
    render(<Roles viewerDisabled />);
    expect(radio('Viewer').getAttribute('aria-disabled')).toBe('true');
    expect(radio('Viewer').disabled).toBe(false);
    expect(radio('Editor').hasAttribute('aria-disabled')).toBe(false);
  });

  it('is reached by the arrow keys but never chosen', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Roles viewerDisabled defaultValue="editor" onChange={onChange} />);
    radio('Editor').focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(radio('Viewer'));
    expect(chosen()).toEqual(['editor']);
    await user.click(radio('Viewer'));
    await user.click(screen.getByText('Viewer'));
    expect(chosen()).toEqual(['editor']);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('paints with the disabled family and never with opacity', () => {
    render(<Roles viewerDisabled />);
    const label = radio('Viewer').closest('label') as HTMLElement;
    expect(classesOf(label)).toContain('text-disabled-text');
    const drawn = only(label.querySelectorAll('[data-box]'));
    expect(classesOf(drawn)).toEqual(
      expect.arrayContaining(['border-disabled-edge', 'bg-disabled-fill']),
    );
    for (const el of [label, ...label.querySelectorAll('*')]) {
      expect(classesOf(el).filter((c) => /(^|:)opacity-/.test(c))).toEqual([]);
    }
  });
});

describe('a disabled RadioGroup', () => {
  it('keeps every radio focusable with aria-disabled and ignores every choice', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Roles disabled defaultValue="owner" onChange={onChange} />);
    expect(group().getAttribute('aria-disabled')).toBe('true');
    for (const name of ['Owner', 'Editor', 'Viewer']) {
      expect(radio(name).getAttribute('aria-disabled'), name).toBe('true');
      expect(radio(name).disabled, name).toBe(false);
    }
    await user.click(radio('Editor'));
    radio('Owner').focus();
    await user.keyboard('{ArrowDown}');
    expect(chosen()).toEqual(['owner']);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('turns live again when disabled is dropped', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<Roles disabled onChange={onChange} />);
    rerender(<Roles onChange={onChange} />);
    expect(group().hasAttribute('aria-disabled')).toBe(false);
    expect(radio('Owner').hasAttribute('aria-disabled')).toBe(false);
    await userEvent.setup().click(radio('Owner'));
    expect(onChange).toHaveBeenCalledWith('owner');
  });
});
