import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { toast, ToastRegion, useLandmark } from '../../src/react/index.ts';

type Handle = ReturnType<typeof toast>;
const opened: Handle[] = [];

afterEach(() => {
  act(() => {
    for (const handle of opened.splice(0)) handle.close();
  });
  cleanup();
});

// A page laid out like the dashboard shell: a bar, a sidebar that can step aside, main, and
// the one toast region after them.
function Page({ skipNav = false, toasts = false }: { skipNav?: boolean; toasts?: boolean }) {
  const bar = useRef<HTMLElement>(null);
  const nav = useRef<HTMLElement>(null);
  const main = useRef<HTMLElement>(null);
  const barProps = useLandmark(bar, { role: 'banner' });
  const navProps = useLandmark(nav, { role: 'navigation', label: 'Sections', skip: skipNav });
  const mainProps = useLandmark(main, { role: 'main' });
  return (
    <>
      <header ref={bar} {...barProps}>
        <button type="button">Account</button>
      </header>
      <nav ref={nav} {...navProps}>
        <a href="#overview">Overview</a>
      </nav>
      <main ref={main} {...mainProps}>
        <button type="button">Edit page</button>
      </main>
      {toasts ? <ToastRegion /> : null}
    </>
  );
}

const f6 = (shift = false, alt = false) => {
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: 'F6',
      shiftKey: shift,
      altKey: alt,
    });
  });
};

// The landmark holding focus, by its role name.
function where(): string {
  const el = document.activeElement;
  if (el === null || el === document.body) return 'body';
  if (el.closest('header') !== null) return 'banner';
  if (el.closest('nav') !== null) return 'navigation';
  if (el.closest('main') !== null) return 'main';
  if (el.closest('[role="region"]') !== null) return 'notifications';
  return 'none';
}

function cycle(presses: number, shift = false): string[] {
  const seen: string[] = [];
  for (let i = 0; i < presses; i += 1) {
    f6(shift);
    seen.push(where());
  }
  return seen;
}

describe('useLandmark', () => {
  it('makes the element a focus target and names it', () => {
    render(<Page />);
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    expect(nav.getAttribute('tabindex')).toBe('-1');
    expect(screen.getByRole('banner').getAttribute('tabindex')).toBe('-1');
    expect(screen.getByRole('banner').hasAttribute('aria-label')).toBe(false);
    // The element keeps its own role; the hook adds none.
    expect(nav.hasAttribute('role')).toBe(false);
  });

  it('moves focus through the landmarks in page order with F6, and back with Shift+F6', () => {
    render(<Page />);
    expect(cycle(4)).toEqual(['banner', 'navigation', 'main', 'banner']);
    expect(cycle(2, true)).toEqual(['main', 'navigation']);
  });

  it('focuses the landmark itself, not the first control inside it', () => {
    render(<Page />);
    f6();
    expect(document.activeElement).toBe(screen.getByRole('banner'));
  });

  it('goes straight to main with Alt+F6', () => {
    render(<Page />);
    f6(false, true);
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });

  it('leaves out a landmark that is skipped, and takes it back when it returns', () => {
    const { rerender } = render(<Page skipNav />);
    expect(cycle(3)).toEqual(['banner', 'main', 'banner']);
    rerender(<Page />);
    expect(cycle(2)).toEqual(['navigation', 'main']);
  });

  it('lets F6 into the toast region after main and out of it again, both ways', () => {
    render(<Page toasts />);
    act(() => {
      opened.push(toast({ title: 'Archived Pricing', undo: () => undefined }));
    });
    expect(screen.getByRole('region', { name: /notification/i })).toBeTruthy();
    expect(cycle(5)).toEqual(['banner', 'navigation', 'main', 'notifications', 'banner']);
    expect(cycle(2, true)).toEqual(['notifications', 'main']);
  });

  it('stops registering when the element unmounts', () => {
    function Only({ withNav }: { withNav: boolean }): ReactNode {
      return withNav ? <Page /> : <button type="button">Alone</button>;
    }
    const { rerender } = render(<Only withNav />);
    rerender(<Only withNav={false} />);
    screen.getByRole('button', { name: 'Alone' }).focus();
    f6();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Alone' }));
  });
});
