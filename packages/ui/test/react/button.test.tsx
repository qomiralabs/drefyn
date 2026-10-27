import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createRef, type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button, IconCheck } from '../../src/react/index.ts';
import { classesOf, FORBIDDEN_LOOKS, only } from './classes.ts';

afterEach(cleanup);

type Variant = NonNullable<ComponentProps<typeof Button>['variant']>;
type Size = NonNullable<ComponentProps<typeof Button>['size']>;
const VARIANTS: Variant[] = ['primary', 'secondary', 'quiet'];
const SIZES: Size[] = ['sm', 'md', 'lg'];

const button = (name: string) => screen.getByRole('button', { name });

describe('Button', () => {
  it('renders a native button of type button, named by its label', () => {
    render(<Button>Save draft</Button>);
    const el = button('Save draft');
    expect(el.tagName).toBe('BUTTON');
    expect(el.getAttribute('type')).toBe('button');
  });

  it('keeps an explicit submit or reset type', () => {
    render(
      <>
        <Button type="submit">Publish update</Button>
        <Button type="reset">Clear</Button>
      </>,
    );
    expect(button('Publish update').getAttribute('type')).toBe('submit');
    expect(button('Clear').getAttribute('type')).toBe('reset');
  });

  it('runs its handler once per press', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save draft</Button>);
    await userEvent.setup().click(button('Save draft'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is secondary at the dashboard size by default', () => {
    render(
      <>
        <Button>Default</Button>
        <Button variant="secondary" size="md">
          Explicit
        </Button>
      </>,
    );
    expect(classesOf(button('Default'))).toEqual(classesOf(button('Explicit')));
  });

  it('paints primary in accent ink with the on accent label, pressing to accent press', () => {
    render(<Button variant="primary">Publish update</Button>);
    const classes = classesOf(button('Publish update'));
    expect(classes).toEqual(
      expect.arrayContaining(['bg-accent-ink', 'text-accent-on', 'hover:bg-accent-press']),
    );
  });

  it('paints secondary on paper with the strong rule and body text, hovering to the hover fill', () => {
    render(<Button variant="secondary">Save draft</Button>);
    const classes = classesOf(button('Save draft'));
    expect(classes).toEqual(
      expect.arrayContaining(['bg-ground', 'border-rule-strong', 'text-body', 'hover:bg-hover']),
    );
  });

  it('paints quiet with no fill or edge and secondary text, hovering to the hover fill', () => {
    render(<Button variant="quiet">Cancel</Button>);
    const classes = classesOf(button('Cancel'));
    expect(classes).toEqual(expect.arrayContaining(['text-secondary', 'hover:bg-hover']));
    expect(classes.filter((c) => c.startsWith('bg-') && c !== 'bg-transparent')).toEqual([]);
    expect(classes.filter((c) => c.startsWith('border-rule'))).toEqual([]);
  });

  it('takes its height from the control size tokens', () => {
    render(
      <>
        {SIZES.map((size) => (
          <Button key={size} size={size}>
            {size}
          </Button>
        ))}
      </>,
    );
    for (const size of SIZES) {
      expect(classesOf(button(size)), size).toContain(`h-control-${size}`);
    }
  });

  it('shows the token focus ring and fades colour on the element itself, in every variant', () => {
    render(
      <>
        {VARIANTS.map((variant) => (
          <Button key={variant} variant={variant}>
            {variant}
          </Button>
        ))}
      </>,
    );
    for (const variant of VARIANTS) {
      const classes = classesOf(button(variant));
      expect(classes, variant).toEqual(
        expect.arrayContaining(['focus-visible:focus-ring', 'transition-colors', 'duration-fast']),
      );
      for (const pattern of FORBIDDEN_LOOKS) {
        expect(
          classes.filter((c) => pattern.test(c)),
          `${variant} ${pattern}`,
        ).toEqual([]);
      }
    }
  });

  it('has no destructive variant: no variant paints with a state colour', () => {
    render(
      <>
        {VARIANTS.map((variant) => (
          <Button key={variant} variant={variant}>
            {variant}
          </Button>
        ))}
      </>,
    );
    for (const variant of VARIANTS) {
      expect(
        classesOf(button(variant)).filter((c) => /state-|signal-/.test(c)),
        variant,
      ).toEqual([]);
    }
  });

  it('rejects a red variant at the type level', () => {
    // @ts-expect-error Deletes are ordinary buttons followed by Undo; there is no red button.
    const destructive = <Button variant="destructive">Delete 3 pages</Button>;
    // @ts-expect-error Same rule under another name.
    const danger = <Button variant="danger">Delete 3 pages</Button>;
    expect([destructive, danger]).toHaveLength(2);
  });

  it('places the icon before the label and keeps it out of the name', () => {
    render(
      <Button icon={<IconCheck />} variant="primary">
        Add component
      </Button>,
    );
    const el = button('Add component');
    const svg = el.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(el.firstElementChild?.contains(svg ?? null)).toBe(true);
  });

  it('passes ARIA, name, value and ref through to the native button', () => {
    const ref = createRef<HTMLButtonElement>();
    render(
      <Button
        ref={ref}
        name="intent"
        value="publish"
        aria-pressed="true"
        aria-keyshortcuts="N"
        aria-describedby="why"
      >
        New incident
      </Button>,
    );
    const el = button('New incident');
    expect(ref.current).toBe(el);
    expect(el.getAttribute('name')).toBe('intent');
    expect(el.getAttribute('value')).toBe('publish');
    expect(el.getAttribute('aria-pressed')).toBe('true');
    expect(el.getAttribute('aria-keyshortcuts')).toBe('N');
    expect(el.getAttribute('aria-describedby')).toBe('why');
  });
});

describe('a disabled Button', () => {
  it('uses aria-disabled, never the disabled attribute, and stays focusable', () => {
    render(<Button disabled>Publish update</Button>);
    const el = button('Publish update');
    expect(el.getAttribute('aria-disabled')).toBe('true');
    expect(el.hasAttribute('disabled')).toBe(false);
    el.focus();
    expect(document.activeElement).toBe(el);
  });

  it('ignores clicks, Enter and Space', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <Button disabled onClick={onClick}>
        Publish update
      </Button>,
    );
    const el = button('Publish update');
    await user.click(el);
    el.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('does not submit its form, where a live submit button does', async () => {
    const submitted: string[] = [];
    const user = userEvent.setup();
    render(
      <form
        aria-label="Incident"
        onSubmit={(event) => {
          event.preventDefault();
          const { submitter } = event.nativeEvent;
          submitted.push(submitter?.textContent ?? '');
        }}
      >
        <Button type="submit" disabled>
          Publish update
        </Button>
        <Button type="submit">Save draft</Button>
      </form>,
    );
    await user.click(button('Publish update'));
    await user.click(button('Save draft'));
    expect(submitted).toEqual(['Save draft']);
  });

  it('paints with the disabled family and no hover or pressed state, in every variant', () => {
    render(
      <>
        {VARIANTS.map((variant) => (
          <Button key={variant} variant={variant} disabled>
            {variant}
          </Button>
        ))}
      </>,
    );
    for (const variant of VARIANTS) {
      const classes = classesOf(button(variant));
      expect(classes, variant).toContain('text-disabled-text');
      expect(
        classes.filter((c) => /^(hover|active):/.test(c)),
        variant,
      ).toEqual([]);
      expect(
        classes.filter((c) => /(^|:)opacity-/.test(c)),
        variant,
      ).toEqual([]);
      expect(classes, variant).toContain('focus-visible:focus-ring');
    }
    for (const variant of ['primary', 'secondary'] as const) {
      expect(classesOf(button(variant)), variant).toEqual(
        expect.arrayContaining(['bg-disabled-fill', 'border-disabled-edge']),
      );
    }
  });
});

// Both labels are always in the markup, so a test with no stylesheet cannot ask for the
// button by name; the browser specs check the name and the accessibility tree.
const theButton = () => screen.getByRole('button');

// The two label elements a button that can be busy lays over each other.
function labels(el: HTMLElement) {
  const rest = [...el.querySelectorAll('[data-label="rest"]')];
  const busy = [...el.querySelectorAll('[data-label="busy"]')];
  expect(rest, 'rest label').toHaveLength(1);
  expect(busy, 'busy label').toHaveLength(1);
  return { rest: only(rest), busy: only(busy) };
}

describe('a busy Button', () => {
  it('sets aria-disabled and data-busy, stays focusable and ignores activation', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <Button variant="primary" busy busyLabel="Publishing" onClick={onClick}>
        Publish update
      </Button>,
    );
    const el = theButton();
    expect(el.getAttribute('aria-disabled')).toBe('true');
    expect(el.hasAttribute('data-busy')).toBe(true);
    expect(el.hasAttribute('disabled')).toBe(false);
    await user.click(el);
    el.focus();
    expect(document.activeElement).toBe(el);
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('cannot be busy without a busy label', () => {
    // @ts-expect-error busy needs busyLabel, so the width can be kept.
    const a = <Button busy>Publish update</Button>;
    // @ts-expect-error Same when busy is false: a button that can be busy always passes it.
    const b = <Button busy={false}>Publish update</Button>;
    const c = (
      <Button busy={false} busyLabel="Publishing">
        Publish update
      </Button>
    );
    const d = <Button busyLabel="Publishing">Publish update</Button>;
    expect([a, b, c, d]).toHaveLength(4);
  });

  it('lays both labels in one grid cell and hides the inactive one with visibility', () => {
    const { rerender } = render(<Button busyLabel="Publishing">Publish update</Button>);
    const atRest = labels(theButton());
    expect(classesOf(theButton())).toEqual(
      expect.arrayContaining([expect.stringMatching(/^(inline-)?grid$/)]),
    );
    for (const label of [atRest.rest, atRest.busy]) {
      expect(classesOf(label)).toEqual(expect.arrayContaining(['col-start-1', 'row-start-1']));
      expect(classesOf(label).filter((c) => /^(hidden|sr-only)$/.test(c))).toEqual([]);
    }
    expect(atRest.rest.textContent).toBe('Publish update');
    expect(atRest.busy.textContent).toBe('Publishing');
    expect(classesOf(atRest.rest)).not.toContain('invisible');
    expect(classesOf(atRest.busy)).toContain('invisible');
    rerender(
      <Button busy busyLabel="Publishing">
        Publish update
      </Button>,
    );
    const busy = labels(theButton());
    expect(classesOf(busy.rest)).toContain('invisible');
    expect(classesOf(busy.busy)).not.toContain('invisible');
  });

  it('keeps the icon with the rest label', () => {
    render(
      <Button busyLabel="Saving" icon={<IconCheck />}>
        Mark as verified
      </Button>,
    );
    const { rest, busy } = labels(theButton());
    expect(rest.querySelectorAll('svg')).toHaveLength(1);
    expect(busy.querySelectorAll('svg')).toHaveLength(0);
  });

  it('announces nothing itself: no live region on or in the button', () => {
    render(
      <Button busy busyLabel="Publishing">
        Publish update
      </Button>,
    );
    const el = theButton();
    expect(el.hasAttribute('aria-live')).toBe(false);
    expect(el.querySelectorAll('[aria-live], [role="status"], [role="alert"]')).toHaveLength(0);
    expect(el.hasAttribute('aria-label')).toBe(false);
  });

  it('shows no spinner', () => {
    render(
      <Button variant="primary" busy busyLabel="Publishing">
        Publish update
      </Button>,
    );
    expect(theButton().querySelectorAll('svg, [role="progressbar"]')).toHaveLength(0);
  });

  it('keeps its variant paint, with a progress cursor and no hover or pressed change', () => {
    const rest: Record<Variant, string[]> = {
      primary: ['bg-accent-ink', 'text-accent-on'],
      secondary: ['bg-ground', 'border-rule-strong', 'text-body'],
      quiet: ['text-secondary'],
    };
    for (const variant of VARIANTS) {
      render(
        <Button variant={variant} busy busyLabel="Working">
          {variant}
        </Button>,
      );
      const classes = classesOf(theButton());
      expect(classes, variant).toEqual(expect.arrayContaining(rest[variant]));
      expect(
        classes.filter((c) => c.includes('disabled-')),
        variant,
      ).toEqual([]);
      expect(
        classes.filter((c) => /^(hover|active):/.test(c)),
        variant,
      ).toEqual([]);
      // Styled from the busy attribute, not from aria-disabled, which disabled uses.
      expect(
        classes.some((c) => /^(data-busy:)?cursor-progress$/.test(c)),
        variant,
      ).toBe(true);
      expect(
        classes.filter((c) => c.startsWith('aria-disabled:')),
        variant,
      ).toEqual([]);
      expect(classes, variant).toContain('focus-visible:focus-ring');
      cleanup();
    }
  });

  it('does not submit its form, so a second press cannot post twice', async () => {
    const submitted: string[] = [];
    render(
      <form
        aria-label="Incident"
        onSubmit={(event) => {
          event.preventDefault();
          submitted.push(event.nativeEvent.submitter?.textContent ?? '');
        }}
      >
        <Button type="submit" variant="primary" busy busyLabel="Publishing">
          Publish update
        </Button>
      </form>,
    );
    const el = theButton();
    expect(el.getAttribute('type')).toBe('button');
    await userEvent.setup().click(el);
    expect(submitted).toEqual([]);
  });
});

describe('a submit Button that changes state', () => {
  it('is a button while disabled or busy and a submit button again once live', () => {
    const { rerender } = render(
      <Button type="submit" disabled busyLabel="Publishing">
        Publish update
      </Button>,
    );
    expect(theButton().getAttribute('type')).toBe('button');
    rerender(
      <Button type="submit" busyLabel="Publishing">
        Publish update
      </Button>,
    );
    expect(theButton().getAttribute('type')).toBe('submit');
    rerender(
      <Button type="submit" busy busyLabel="Publishing">
        Publish update
      </Button>,
    );
    expect(theButton().getAttribute('type')).toBe('button');
    rerender(
      <Button type="submit" busy={false} busyLabel="Publishing">
        Publish update
      </Button>,
    );
    expect(theButton().getAttribute('type')).toBe('submit');
    expect(theButton().hasAttribute('data-busy')).toBe(false);
    expect(theButton().hasAttribute('aria-disabled')).toBe(false);
  });
});

describe('prop names', () => {
  it('uses DOM names and never the React Aria is* or onPress names', () => {
    // @ts-expect-error disabled, not isDisabled.
    const a = <Button isDisabled>Save</Button>;
    // @ts-expect-error onClick, not onPress.
    const b = <Button onPress={() => undefined}>Save</Button>;
    // @ts-expect-error busy, not isPending.
    const c = <Button isPending>Save</Button>;
    expect([a, b, c]).toHaveLength(3);
  });
});

describe('runtime guards for callers without types', () => {
  it('refuses an empty busy label, which would collapse the width it exists to keep', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const busyLabel of ['', '   ']) {
      expect(
        () => render(<Button busyLabel={busyLabel}>Publish update</Button>),
        JSON.stringify(busyLabel),
      ).toThrow(/busy label/i);
      cleanup();
    }
  });

  it('refuses busy without a busy label', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const untyped = { busy: true, children: 'Publish update' } as unknown as ComponentProps<
      typeof Button
    >;
    expect(() => render(<Button {...untyped} />)).toThrow(/busy label/i);
  });

  it('never writes a style attribute from props', () => {
    const untyped = {
      style: { color: 'red' },
      children: 'Save draft',
    } as unknown as ComponentProps<typeof Button>;
    render(<Button {...untyped} />);
    expect(button('Save draft').hasAttribute('style')).toBe(false);
  });
});

describe('press handlers on a Button that cannot act', () => {
  const PRESS = [
    'onClick',
    'onDoubleClick',
    'onAuxClick',
    'onPointerDown',
    'onPointerUp',
    'onMouseDown',
    'onMouseUp',
    'onTouchStart',
    'onTouchEnd',
    'onKeyDown',
    'onKeyUp',
  ] as const;

  for (const state of ['disabled', 'busy'] as const) {
    it(`drops every press handler while ${state}, and keeps hover and focus ones`, async () => {
      const handlers = Object.fromEntries(PRESS.map((name) => [name, vi.fn()]));
      const onPointerEnter = vi.fn();
      const onFocus = vi.fn();
      const stateProps = state === 'disabled' ? { disabled: true } : { busy: true };
      const user = userEvent.setup();
      render(
        <Button
          {...handlers}
          {...stateProps}
          busyLabel="Publishing"
          onPointerEnter={onPointerEnter}
          onFocus={onFocus}
        >
          Publish update
        </Button>,
      );
      const el = theButton();
      await user.hover(el);
      await user.click(el);
      await user.dblClick(el);
      el.focus();
      await user.keyboard('{Enter}');
      await user.keyboard(' ');
      for (const name of PRESS) expect(handlers[name], name).not.toHaveBeenCalled();
      expect(onPointerEnter).toHaveBeenCalled();
      expect(onFocus).toHaveBeenCalled();
    });
  }
});
