import { cleanup, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Button, ButtonLink, IconCheck } from '../../src/react/index.ts';
import { classesOf } from './classes.ts';

afterEach(cleanup);

describe('ButtonLink', () => {
  it('renders a link with its href, named by its label', () => {
    render(<ButtonLink href="/history">View history</ButtonLink>);
    const link = screen.getByRole('link', { name: 'View history' });
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/history');
  });

  it('looks exactly like a Button of the same variant and size', () => {
    for (const variant of ['primary', 'secondary', 'quiet'] as const) {
      for (const size of ['sm', 'md', 'lg'] as const) {
        render(
          <>
            <Button variant={variant} size={size}>
              As button
            </Button>
            <ButtonLink href="#x" variant={variant} size={size}>
              As link
            </ButtonLink>
          </>,
        );
        const fromButton = classesOf(screen.getByRole('button', { name: 'As button' }));
        expect(fromButton.length, `${variant} ${size}`).toBeGreaterThan(0);
        expect(
          classesOf(screen.getByRole('link', { name: 'As link' })),
          `${variant} ${size}`,
        ).toEqual(fromButton);
        cleanup();
      }
    }
  });

  it('says when it opens a new tab and keeps the opener out', () => {
    render(
      <ButtonLink href="https://drefyn.com/docs" target="_blank">
        Read the docs
      </ButtonLink>,
    );
    const link = screen.getByRole('link', { name: /^Read the docs.*opens in a new tab/ });
    const rel = (link.getAttribute('rel') ?? '').split(' ');
    expect(rel).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
  });

  it('adds nothing to a link that stays in the tab', () => {
    render(<ButtonLink href="/history">View history</ButtonLink>);
    const link = screen.getByRole('link', { name: 'View history' });
    expect(link.hasAttribute('target')).toBe(false);
  });

  it('places a decorative icon before the label', () => {
    render(
      <ButtonLink href="/new" icon={<IconCheck />}>
        Add component
      </ButtonLink>,
    );
    const svg = screen.getByRole('link', { name: 'Add component' }).querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });

  it('has no disabled state, because a link cannot be disabled', () => {
    // A link that goes nowhere is text; render text with the reason instead.
    // @ts-expect-error ButtonLink takes no disabled prop.
    const link = <ButtonLink href="/x" disabled children="Nowhere" />;
    expect(link).toBeDefined();
  });
});

describe('ButtonLink for callers without types', () => {
  it('never writes a style attribute from props', () => {
    const untyped = {
      href: '/history',
      style: { color: 'red' },
      children: 'View history',
    } as unknown as ComponentProps<typeof ButtonLink>;
    render(<ButtonLink {...untyped} />);
    expect(screen.getByRole('link', { name: 'View history' }).hasAttribute('style')).toBe(false);
  });
});
