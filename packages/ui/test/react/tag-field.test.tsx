import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { TagField } from '../../src/react/index.ts';
import { classesOf } from './classes.ts';

afterEach(cleanup);

type Props = Partial<ComponentProps<typeof TagField>>;

function Addresses(props: Props) {
  return <TagField label="Email addresses" tagsLabel="Addresses to invite" {...props} />;
}

const input = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'Email addresses' });
const chips = () => screen.queryAllByRole('row').map((row) => row.getAttribute('aria-label'));
const remove = (tag: string) => screen.getByRole('button', { name: new RegExp(`^Remove ${tag}`) });
const describedBy = (el: HTMLElement) =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');

// Where focus goes after a press on a chip button is proven in the browser specs: happy-dom
// hands focus back to the row, which no engine does.
describe('TagField', () => {
  it('starts empty on an input named by its label, with no list of chips', () => {
    render(<Addresses />);
    expect(input().value).toBe('');
    expect(screen.queryByRole('grid')).toBeNull();
    expect(chips()).toEqual([]);
  });

  it('adds a chip on Enter and on a comma and clears the text', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Addresses onChange={onChange} />);
    await user.type(input(), 'kai@acme.dev{Enter}');
    await user.type(input(), 'ren@acme.dev,');
    expect(chips()).toEqual(['kai@acme.dev', 'ren@acme.dev']);
    expect(input().value).toBe('');
    expect(onChange.mock.calls).toEqual([[['kai@acme.dev']], [['kai@acme.dev', 'ren@acme.dev']]]);
  });

  it('adds what was typed when focus leaves, so nothing typed is lost', async () => {
    const user = userEvent.setup();
    render(<Addresses />);
    await user.type(input(), 'kai@acme.dev');
    await user.tab();
    expect(chips()).toEqual(['kai@acme.dev']);
  });

  it('splits a paste on commas, semicolons, spaces and line breaks', () => {
    render(<Addresses />);
    fireEvent.paste(input(), {
      clipboardData: { getData: () => 'a@acme.dev, b@acme.dev;c@acme.dev\nd@acme.dev e@acme.dev' },
    });
    expect(chips()).toEqual(['a@acme.dev', 'b@acme.dev', 'c@acme.dev', 'd@acme.dev', 'e@acme.dev']);
  });

  it('leaves a paste of one tag in the input to be edited', () => {
    render(<Addresses />);
    const event = fireEvent.paste(input(), {
      clipboardData: { getData: () => 'kai@acme.dev' },
    });
    expect(event).toBe(true);
    expect(chips()).toEqual([]);
  });

  it('splits text a phone keyboard put in without a key event', () => {
    render(<Addresses />);
    fireEvent.change(input(), { target: { value: 'kai@acme.dev,' } });
    expect(chips()).toEqual(['kai@acme.dev']);
    expect(input().value).toBe('');
  });

  it('ignores a tag it already has, and blank text', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Addresses defaultValue={['kai@acme.dev']} onChange={onChange} />);
    await user.type(input(), 'kai@acme.dev{Enter}');
    await user.type(input(), '   {Enter}');
    expect(chips()).toEqual(['kai@acme.dev']);
    expect(input().value).toBe('');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('leaves Enter to an input method that is still composing', () => {
    render(<Addresses />);
    fireEvent.change(input(), { target: { value: 'kai' } });
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true });
    expect(chips()).toEqual([]);
    expect(input().value).toBe('kai');
  });

  it('lets Enter submit the form when there is nothing to add', async () => {
    const onSubmit = vi.fn((event: SubmitEvent) => {
      event.preventDefault();
    });
    const user = userEvent.setup();
    render(
      <form aria-label="Invite" ref={(el) => el?.addEventListener('submit', onSubmit)}>
        <Addresses />
      </form>,
    );
    await user.type(input(), 'kai@acme.dev{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
    await user.type(input(), '{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('removes a chip by its button', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Addresses defaultValue={['kai@acme.dev', 'ren@acme.dev']} onChange={onChange} />);
    await user.click(remove('kai@acme.dev'));
    expect(chips()).toEqual(['ren@acme.dev']);
    expect(onChange.mock.calls).toEqual([[['ren@acme.dev']]]);
  });

  it('moves to the last chip on Backspace in an empty input, and a second press removes it', async () => {
    const user = userEvent.setup();
    render(<Addresses defaultValue={['kai@acme.dev', 'ren@acme.dev']} />);
    await user.click(input());
    await user.keyboard('{Backspace}');
    expect(chips()).toEqual(['kai@acme.dev', 'ren@acme.dev']);
    expect(document.activeElement).toBe(screen.getByRole('row', { name: 'ren@acme.dev' }));
    await user.keyboard('{Backspace}');
    expect(chips()).toEqual(['kai@acme.dev']);
  });

  it('keeps Backspace in the text while there is text', async () => {
    const user = userEvent.setup();
    render(<Addresses defaultValue={['kai@acme.dev']} />);
    await user.type(input(), 'r{Backspace}');
    expect(input().value).toBe('');
    expect(document.activeElement).toBe(input());
  });

  it('stays in the input when a held Backspace runs out of text', () => {
    render(<Addresses defaultValue={['kai@acme.dev']} />);
    input().focus();
    fireEvent.keyDown(input(), { key: 'Backspace', repeat: true });
    expect(document.activeElement).toBe(input());
  });

  it('sends focus to the input when the last chip goes', async () => {
    const user = userEvent.setup();
    render(<Addresses defaultValue={['kai@acme.dev']} />);
    await user.click(input());
    await user.keyboard('{Backspace}{Backspace}');
    expect(chips()).toEqual([]);
    expect(document.activeElement).toBe(input());
  });

  it('follows its value prop when controlled', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<Addresses value={['kai@acme.dev']} onChange={onChange} />);
    await user.type(input(), 'ren@acme.dev{Enter}');
    expect(onChange.mock.calls).toEqual([[['kai@acme.dev', 'ren@acme.dev']]]);
    expect(chips()).toEqual(['kai@acme.dev']);
    rerender(<Addresses value={['kai@acme.dev', 'ren@acme.dev']} onChange={onChange} />);
    expect(chips()).toEqual(['kai@acme.dev', 'ren@acme.dev']);
  });

  it('posts one value per chip under its name', () => {
    render(
      <form aria-label="Invite">
        <Addresses name="to" defaultValue={['kai@acme.dev', 'ren@acme.dev']} />
      </form>,
    );
    const form = screen.getByRole<HTMLFormElement>('form', { name: 'Invite' });
    expect(new FormData(form).getAll('to')).toEqual(['kai@acme.dev', 'ren@acme.dev']);
  });

  it('names the list of chips apart from the input', () => {
    render(<Addresses defaultValue={['kai@acme.dev']} />);
    expect(screen.getByRole('grid').getAttribute('aria-label')).toBe('Addresses to invite');
  });

  it('marks required on the input only until a chip exists', async () => {
    const user = userEvent.setup();
    render(<Addresses required />);
    expect(input().getAttribute('aria-required')).toBe('true');
    await user.type(input(), 'kai@acme.dev{Enter}');
    expect(input().hasAttribute('aria-required')).toBe(false);
  });

  it('joins its description to the input', () => {
    render(<Addresses description="Enter or a comma adds each one." />);
    expect(describedBy(input())).toContain('Enter or a comma adds each one.');
  });

  it('needs a visible label', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<TagField label=" " />)).toThrow(/label/);
  });

  it('uses DOM names and never the React Aria ones', () => {
    // @ts-expect-error disabled, not isDisabled.
    const a = <TagField label="To" isDisabled />;
    // @ts-expect-error value, not items.
    const b = <TagField label="To" items={[]} />;
    expect([a, b]).toHaveLength(2);
  });
});

describe('a chip with an error', () => {
  const errors = { 'lee.k@acme': 'lee.k@acme is not a full address.' };

  it('draws the broken edge and the alert mark on that chip alone', () => {
    render(<Addresses defaultValue={['kai@acme.dev', 'lee.k@acme']} tagErrors={errors} />);
    const bad = screen.getByRole('row', { name: /^lee\.k@acme/ });
    const good = screen.getByRole('row', { name: 'kai@acme.dev' });
    expect(classesOf(bad)).toContain('border-state-broken-mark');
    expect(bad.querySelector('[data-icon="alert"]')).not.toBeNull();
    expect(classesOf(good)).not.toContain('border-state-broken-mark');
    expect(good.querySelector('[data-icon="alert"]')).toBeNull();
  });

  it('says so in the chip name, for a reader that lands on it', () => {
    render(<Addresses defaultValue={['lee.k@acme']} tagErrors={errors} />);
    expect(chips()).toEqual(['lee.k@acme, has an error']);
  });

  it('lists each message under the field and joins them to the input', () => {
    render(
      <Addresses
        defaultValue={['lee.k@acme', 'sam@acme.dev']}
        tagErrors={{ ...errors, 'sam@acme.dev': 'sam@acme.dev is already in Acme.' }}
      />,
    );
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(describedBy(input())).toContain('lee.k@acme is not a full address.');
    expect(describedBy(input())).toContain('sam@acme.dev is already in Acme.');
    expect(classesOf(screen.getByRole('group', { name: 'Email addresses' }))).toContain(
      'border-state-broken-mark',
    );
  });

  it('forgets a message whose chip is gone', async () => {
    const user = userEvent.setup();
    render(<Addresses defaultValue={['lee.k@acme']} tagErrors={errors} />);
    await user.click(remove('lee\\.k@acme'));
    expect(screen.queryByText('lee.k@acme is not a full address.')).toBeNull();
    expect(input().hasAttribute('aria-invalid')).toBe(false);
  });

  it('shows a field wide error too', () => {
    render(<Addresses error="Add at least one address." />);
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(describedBy(input())).toContain('Add at least one address.');
  });
});

describe('a disabled TagField', () => {
  it('stays focusable with aria-disabled and never changes', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Addresses disabled defaultValue={['kai@acme.dev']} onChange={onChange} />);
    expect(input().getAttribute('aria-disabled')).toBe('true');
    expect(input().disabled).toBe(false);
    await user.click(input());
    expect(document.activeElement).toBe(input());
    await user.keyboard('ren@acme.dev,{Enter}{Backspace}{Backspace}');
    fireEvent.paste(input(), { clipboardData: { getData: () => 'a@acme.dev, b@acme.dev' } });
    expect(chips()).toEqual(['kai@acme.dev']);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps Backspace from reaching the browser, which can go back a page', () => {
    render(<Addresses disabled />);
    expect(fireEvent.keyDown(input(), { key: 'Backspace' })).toBe(false);
  });

  it('offers no way to remove a chip and paints with the disabled family', () => {
    render(<Addresses disabled defaultValue={['kai@acme.dev']} />);
    const row = screen.getByRole('row', { name: 'kai@acme.dev' });
    expect(within(row).queryByRole('button')).toBeNull();
    expect(classesOf(row)).toEqual(
      expect.arrayContaining(['border-disabled-edge', 'bg-disabled-fill', 'text-disabled-text']),
    );
    for (const el of [row, ...row.querySelectorAll('*')]) {
      expect(classesOf(el).filter((c) => /(^|:)opacity-/.test(c))).toEqual([]);
    }
  });
});
