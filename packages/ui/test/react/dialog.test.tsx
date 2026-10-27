import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button, Dialog, TextField } from '../../src/react/index.ts';
import { classesOf } from './classes.ts';

afterEach(cleanup);

function Invite({
  busy = false,
  onSend = () => undefined,
}: {
  busy?: boolean;
  onSend?: () => void;
}) {
  return (
    <Dialog
      trigger="Invite people"
      title="Invite people"
      description="They get an email with a link that works for seven days."
      busy={busy}
      footer={(close) => (
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={onSend} busy={busy} busyLabel="Sending">
            Send invites
          </Button>
        </>
      )}
    >
      <TextField id="invite-email" name="email" label="Email addresses" />
    </Dialog>
  );
}

const trigger = () => screen.getByRole('button', { name: 'Invite people' });
const dialog = () => screen.getByRole('dialog', { name: 'Invite people' });

describe('Dialog', () => {
  it('starts closed behind a trigger that says it opens a dialog', () => {
    render(<Invite />);
    expect(trigger().getAttribute('aria-expanded')).not.toBe('true');
    expect(trigger().getAttribute('aria-haspopup')).toBe('dialog');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens a dialog named by its title and described by its description', async () => {
    render(<Invite />);
    await userEvent.setup().click(trigger());
    const el = dialog();
    const described = document.getElementById(el.getAttribute('aria-describedby') ?? '');
    expect(described?.textContent).toBe('They get an email with a link that works for seven days.');
    expect(within(el).getByRole('heading', { name: 'Invite people' })).toBeDefined();
  });

  it('puts focus in the first field', async () => {
    render(<Invite />);
    await userEvent.setup().click(trigger());
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Email addresses' }));
  });

  it('puts focus on the dialog, which reads its title, when it has no field', async () => {
    render(
      <Dialog trigger="Keyboard shortcuts" title="Keyboard shortcuts">
        <p>Press Cmd K to search.</p>
      </Dialog>,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Keyboard shortcuts' }));
  });

  it('closes from its close button and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<Invite />);
    await user.click(trigger());
    await user.click(within(dialog()).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(<Invite />);
    await user.click(trigger());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('gives the footer a close callback', async () => {
    const user = userEvent.setup();
    render(<Invite />);
    await user.click(trigger());
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps typed input when the pointer lands outside', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Button>Somewhere else</Button>
        <Invite />
      </>,
    );
    await user.click(trigger());
    await user.type(screen.getByRole('textbox', { name: 'Email addresses' }), 'ada@example.com');
    await user.click(document.body);
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Email addresses' }).value).toBe(
      'ada@example.com',
    );
  });

  it('stays open while busy: Escape and the close button wait for the submit', async () => {
    const user = userEvent.setup();
    function Sending() {
      const [busy, setBusy] = useState(false);
      return (
        <Dialog
          trigger="Invite people"
          title="Invite people"
          busy={busy}
          footer={
            <Button
              variant="primary"
              busy={busy}
              busyLabel="Sending"
              onClick={() => {
                setBusy(true);
              }}
            >
              Send invites
            </Button>
          }
        >
          <TextField id="invite-email" label="Email addresses" />
        </Dialog>
      );
    }
    render(<Sending />);
    await user.click(trigger());
    await user.click(screen.getByRole('button', { name: 'Send invites' }));
    expect(dialog().getAttribute('aria-busy')).toBe('true');
    await user.keyboard('{Escape}');
    expect(dialog()).toBeDefined();
    const close = within(dialog()).getByRole('button', { name: 'Close' });
    expect(close.getAttribute('aria-disabled')).toBe('true');
    await user.click(close);
    expect(dialog()).toBeDefined();
  });

  it('shows a failed submit at the top of the body and moves focus to it', async () => {
    const user = userEvent.setup();
    function Failing() {
      const [error, setError] = useState<string | undefined>(undefined);
      return (
        <Dialog
          trigger="Invite people"
          title="Invite people"
          {...(error === undefined ? {} : { error })}
          footer={
            <Button
              variant="primary"
              onClick={() => {
                setError('Could not send the invites. Try again.');
              }}
            >
              Send invites
            </Button>
          }
        >
          <TextField id="invite-email" label="Email addresses" />
        </Dialog>
      );
    }
    render(<Failing />);
    await user.click(trigger());
    expect(within(dialog()).queryByText('Could not send the invites. Try again.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Send invites' }));
    const message = within(dialog()).getByText('Could not send the invites. Try again.');
    const holder = message.closest('[tabindex]');
    if (holder === null) throw new Error('the message is not focusable');
    expect(document.activeElement).toBe(holder);
    expect(classesOf(holder)).toContain('text-state-broken-text');
    expect(holder.querySelector('svg[data-icon="alert"]')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    // It sits before the fields, so Tab goes from the message to the first field.
    const field = screen.getByRole('textbox', { name: 'Email addresses' });
    expect(holder.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('opens and closes from state the caller holds, with no trigger of its own', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    function Held() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button
            onClick={() => {
              setOpen(true);
            }}
          >
            Open search
          </Button>
          <Dialog
            open={open}
            onOpenChange={(next) => {
              onOpenChange(next);
              setOpen(next);
            }}
            title="Search"
          >
            <TextField id="search" label="Search" type="search" />
          </Dialog>
        </>
      );
    }
    render(<Held />);
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open search' }));
    expect(screen.getByRole('dialog', { name: 'Search' })).toBeDefined();
    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open search' }));
  });

  it('floats on the overlay surface with the large shadow over the scrim', async () => {
    render(<Invite />);
    await userEvent.setup().click(trigger());
    const seen: string[] = [];
    for (let el: HTMLElement | null = dialog(); el !== null && el !== document.body;) {
      seen.push(...classesOf(el));
      el = el.parentElement;
    }
    expect(seen).toEqual(
      expect.arrayContaining([
        'z-overlay',
        'bg-overlay-scrim',
        'bg-overlay',
        'border-rule-strong',
        'shadow-2',
        'sm:rounded-md',
        'sm:max-w-measure',
        'pb-safe-bottom',
        'sm:pb-0',
      ]),
    );
    expect(seen.filter((c) => /(^|:)(opacity-|backdrop-blur|blur)/.test(c))).toEqual([]);
  });

  it('styles its trigger with the same class function as Button', () => {
    render(
      <>
        <Dialog trigger="Create page" variant="primary" title="Create page">
          <p>Body</p>
        </Dialog>
        <Button variant="primary">Plain</Button>
      </>,
    );
    const plain = classesOf(screen.getByRole('button', { name: 'Plain' }));
    expect(classesOf(screen.getByRole('button', { name: 'Create page' }))).toEqual(
      expect.arrayContaining(plain),
    );
  });

  it('can start open, for a story or a test of the open state', () => {
    render(
      <Dialog trigger="Invite people" title="Invite people" defaultOpen>
        <p>Body</p>
      </Dialog>,
    );
    expect(dialog()).toBeDefined();
  });

  it('refuses an empty title, which would leave the dialog unnamed', () => {
    for (const title of ['', '  ']) {
      expect(
        () =>
          render(
            <Dialog trigger="Open" title={title} defaultOpen>
              <p>Body</p>
            </Dialog>,
          ),
        JSON.stringify(title),
      ).toThrow(/title/i);
    }
  });

  it('needs a trigger or open state, and takes no styling props', () => {
    // @ts-expect-error neither a trigger nor open state.
    const a = <Dialog title="Search" children="Body" />;
    // @ts-expect-error no className.
    const b = <Dialog trigger="Open" title="Search" className="x" children="Body" />;
    // @ts-expect-error open, not isOpen.
    const c = <Dialog isOpen title="Search" children="Body" />;
    // @ts-expect-error defaultOpen needs a trigger to return focus to.
    const d = <Dialog open defaultOpen title="Search" children="Body" />;
    expect([a, b, c, d]).toHaveLength(4);
  });
});
