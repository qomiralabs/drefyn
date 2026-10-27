import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TextField } from '../../src/react/index.ts';
import { classesOf, FORBIDDEN_LOOKS } from './classes.ts';

afterEach(cleanup);

const field = (name = 'Site name') => screen.getByRole<HTMLInputElement>('textbox', { name });
const describedBy = (el: Element) =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter((id) => id !== '')
    .map((id) => document.getElementById(id)?.textContent ?? `missing ${id}`);

describe('TextField', () => {
  it('is a native input named by its visible label', () => {
    render(<TextField id="site-name" label="Site name" />);
    const input = field();
    expect(input.tagName).toBe('INPUT');
    expect(input.type).toBe('text');
    expect(input.id).toBe('site-name');
    expect(document.querySelector('label[for="site-name"]')?.textContent).toBe('Site name');
  });

  it('joins the description to the input', () => {
    render(
      <TextField
        id="site-name"
        label="Site name"
        description="Shown in the browser tab and search results."
      />,
    );
    expect(describedBy(field())).toEqual(['Shown in the browser tab and search results.']);
    expect(field().hasAttribute('aria-invalid')).toBe(false);
  });

  it('marks an invalid value and joins the message after the description', () => {
    render(
      <TextField
        id="site-name"
        label="Site name"
        description="Shown in the browser tab."
        error="Enter a name of 80 characters or fewer."
      />,
    );
    const input = field();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(describedBy(input)).toEqual([
      'Shown in the browser tab.',
      'Enter a name of 80 characters or fewer.',
    ]);
  });

  it('draws an invalid field with the broken edge and the message with the alert shape', () => {
    render(<TextField id="site-name" label="Site name" error="Enter a name." />);
    expect(classesOf(field())).toContain('border-state-broken-mark');
    const message = screen.getByText('Enter a name.');
    const holder = message.closest('[id]') ?? message;
    expect(classesOf(holder)).toContain('text-state-broken-text');
    const icon = holder.querySelector('svg[data-icon="alert"]');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
  });

  it('is not a live region: the form decides when to announce errors', () => {
    render(<TextField id="site-name" label="Site name" error="Enter a name." />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.querySelector('[aria-live]')).toBeNull();
  });

  it('calls onChange with the value, not an event', async () => {
    const onChange = vi.fn();
    render(<TextField id="site-name" label="Site name" onChange={onChange} />);
    await userEvent.setup().type(field(), 'Docs');
    expect(onChange).toHaveBeenLastCalledWith('Docs');
  });

  it('posts its value by name in a form, with JS or without', () => {
    render(
      <form aria-label="Site">
        <TextField id="site-name" name="name" label="Site name" defaultValue="Acme docs" />
      </form>,
    );
    const form = screen.getByRole<HTMLFormElement>('form', { name: 'Site' });
    expect(new FormData(form).get('name')).toBe('Acme docs');
  });

  it('stays focusable when disabled, ignores typing, and reads as unavailable', async () => {
    const onChange = vi.fn();
    render(
      <TextField
        id="site-name"
        label="Site name"
        defaultValue="Acme docs"
        disabled
        description="Only owners can rename a site."
        onChange={onChange}
      />,
    );
    const input = field();
    expect(input.getAttribute('aria-disabled')).toBe('true');
    expect(input.disabled).toBe(false);
    expect(input.readOnly).toBe(true);
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(input);
    await user.type(input, 'x');
    expect(input.value).toBe('Acme docs');
    expect(onChange).not.toHaveBeenCalled();
    expect(describedBy(input)).toEqual(['Only owners can rename a site.']);
  });

  it('paints disabled with the disabled family, the label too, and keeps the reason readable', () => {
    render(
      <TextField id="site-name" label="Site name" disabled description="Only owners can rename." />,
    );
    expect(classesOf(field())).toEqual(
      expect.arrayContaining(['bg-disabled-fill', 'border-disabled-edge', 'text-disabled-text']),
    );
    expect(classesOf(document.querySelector('label') as Element)).toContain('text-disabled-text');
    expect(classesOf(screen.getByText('Only owners can rename.'))).toContain('text-secondary');
  });

  it('shows a read only value on the raised fill with no edge, still focusable', async () => {
    render(<TextField id="site-id" label="Site ID" defaultValue="site_fixture" readOnly />);
    const input = field('Site ID');
    expect(input.readOnly).toBe(true);
    expect(input.hasAttribute('aria-disabled')).toBe(false);
    expect(classesOf(input)).toEqual(expect.arrayContaining(['bg-raised', 'border-transparent']));
    await userEvent.setup().tab();
    expect(document.activeElement).toBe(input);
  });

  it('takes the control sizes and the token ring outside its edge', () => {
    render(
      <>
        <TextField id="a" label="Medium" />
        <TextField id="b" label="Large" size="lg" />
      </>,
    );
    expect(classesOf(field('Medium'))).toEqual(
      expect.arrayContaining([
        'h-control-md',
        'border-control',
        'bg-ground',
        'focus-visible:focus-ring',
      ]),
    );
    expect(classesOf(field('Large'))).toContain('h-control-lg');
  });

  it('draws placeholders in secondary text, never subtle', () => {
    render(<TextField id="site-url" label="Address" type="url" placeholder="https://" />);
    const input = screen.getByRole('textbox', { name: 'Address' });
    expect(classesOf(input)).toContain('placeholder:text-secondary');
    expect(classesOf(input).filter((c) => c.includes('subtle'))).toEqual([]);
  });

  it('never dims, loops or moves behind a variant', () => {
    render(<TextField id="site-name" label="Site name" disabled error="Enter a name." />);
    const all = [...document.body.querySelectorAll('*')].flatMap((el) => classesOf(el));
    for (const pattern of FORBIDDEN_LOOKS) {
      expect(
        all.filter((c) => pattern.test(c)),
        String(pattern),
      ).toEqual([]);
    }
  });

  it('refuses an empty label or id', () => {
    expect(() => render(<TextField id="x" label=" " />)).toThrow(/label/i);
    expect(() => render(<TextField id="" label="Site name" />)).toThrow(/id/i);
  });

  it('never writes a style attribute from props, for callers without types', () => {
    const untyped = {
      id: 'site-name',
      label: 'Site name',
      style: { color: 'red' },
      className: 'x',
    } as unknown as ComponentProps<typeof TextField>;
    render(<TextField {...untyped} />);
    expect(field().hasAttribute('style')).toBe(false);
    expect(classesOf(field())).not.toContain('x');
  });

  it('uses DOM names, and takes no styling props', () => {
    // @ts-expect-error disabled, not isDisabled.
    const a = <TextField id="a" label="A" isDisabled />;
    // @ts-expect-error no className.
    const b = <TextField id="a" label="A" className="x" />;
    // @ts-expect-error an id is required to wire the label without a hook.
    const c = <TextField label="A" />;
    expect([a, b, c]).toHaveLength(3);
  });
});
