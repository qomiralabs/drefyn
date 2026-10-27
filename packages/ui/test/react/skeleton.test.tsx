import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Skeleton } from '../../src/react/index.ts';
import { classesOf, rootOf } from './classes.ts';

afterEach(cleanup);

describe('Skeleton', () => {
  it('is hidden from screen readers; the region it fills carries aria-busy', () => {
    const { container } = render(<Skeleton />);
    const block = rootOf(container);
    expect(block.getAttribute('aria-hidden')).toBe('true');
    expect(block.textContent).toBe('');
    expect(block.hasAttribute('role')).toBe(false);
  });

  it('is a span, so it can stand in for text inside a cell or a paragraph', () => {
    const { container } = render(
      <p>
        <Skeleton />
      </p>,
    );
    expect(container.querySelector('p > span[aria-hidden="true"]')).not.toBeNull();
  });

  it('paints with the skeleton fill in every shape and never shimmers or pulses', () => {
    for (const shape of ['text', 'block', 'circle'] as const) {
      const { container } = render(<Skeleton shape={shape} />);
      const classes = classesOf(rootOf(container));
      expect(classes, shape).toContain('bg-skeleton-fill');
      expect(
        classes.filter((c) => /(^|:)(animate-|opacity-|transition)/.test(c)),
        shape,
      ).toEqual([]);
      cleanup();
    }
  });

  it('rounds a circle fully and keeps text and blocks to the small radius', () => {
    const shapes = { text: 'rounded-xs', block: 'rounded-xs', circle: 'rounded-full' } as const;
    for (const [shape, radius] of Object.entries(shapes)) {
      const { container } = render(<Skeleton shape={shape as keyof typeof shapes} />);
      expect(classesOf(rootOf(container)), shape).toContain(radius);
      cleanup();
    }
  });

  it('is a text line at full width by default and takes a fraction of the width when asked', () => {
    const { container, rerender } = render(<Skeleton />);
    const expected = new Map([
      ['1/4', 'w-1/4'],
      ['1/2', 'w-1/2'],
      ['3/4', 'w-3/4'],
      ['full', 'w-full'],
    ] as const);
    expect(classesOf(rootOf(container))).toContain('w-full');
    for (const [width, utility] of expected) {
      rerender(<Skeleton width={width} />);
      expect(classesOf(rootOf(container)), width).toContain(utility);
    }
  });
});
