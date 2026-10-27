import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement, type FunctionComponent } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import * as components from '../../src/react/index.ts';
import { classesOf, only } from './classes.ts';

afterEach(cleanup);

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'react', 'icons');

interface IconProps {
  size?: 'sm' | 'md' | 'lg';
  label?: string;
}

const pascal = (kebab: string) =>
  kebab
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

const icons = Object.entries(components)
  .filter(([name]) => name.startsWith('Icon'))
  .map(([name, value]) => [name, value as FunctionComponent<IconProps>] as const);

// The icons this batch draws: state shapes, the error mark and the menu triggers. The set
// grows with the components that need it, never ahead of them.
const V1 = ['alert', 'check', 'chevron-down', 'clock', 'cross', 'hatch', 'more'];

const SHAPES = 'path, line, rect, circle, polyline, polygon, ellipse';

function numbersIn(el: Element): number[] {
  const values: number[] = [];
  for (const attr of [
    'd',
    'x',
    'y',
    'x1',
    'y1',
    'x2',
    'y2',
    'cx',
    'cy',
    'r',
    'width',
    'height',
    'points',
  ]) {
    const value = el.getAttribute(attr);
    if (value === null) continue;
    for (const match of value.matchAll(/-?\d*\.?\d+/g)) values.push(Number(match[0]));
  }
  return values;
}

describe('the icon set', () => {
  it('has one file per icon, each exported from the entry as Icon plus its name', () => {
    const files = readdirSync(dir)
      .filter((file) => file.endsWith('.tsx') && file !== 'icon.tsx')
      .map((file) => file.replace(/\.tsx$/, ''))
      .sort();
    expect(files).toEqual(V1);
    expect(icons.map(([name]) => name).sort()).toEqual(files.map((f) => `Icon${pascal(f)}`).sort());
  });

  for (const [name, Icon] of icons) {
    describe(name, () => {
      it('draws on the 24 grid with the current colour, no fill and square terminals', () => {
        const { container } = render(createElement(Icon));
        const svg = container.querySelector('svg');
        expect(svg).not.toBeNull();
        if (svg === null) return;
        expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
        expect(svg.getAttribute('fill')).toBe('none');
        expect(svg.getAttribute('stroke')).toBe('currentColor');
        expect(svg.getAttribute('stroke-linecap')).toBe('butt');
        expect(svg.getAttribute('stroke-linejoin')).toBe('miter');
        // The width comes from the stroke token, so no element may set its own.
        expect(container.querySelectorAll('[stroke-width]')).toHaveLength(0);
        const shapes = [...svg.querySelectorAll(SHAPES)];
        expect(shapes.length).toBeGreaterThan(0);
        for (const shape of shapes) {
          expect(shape.getAttribute('fill') ?? 'none').toBe('none');
          for (const n of numbersIn(shape)) {
            expect(n, `${name} ${shape.outerHTML}`).toBeGreaterThanOrEqual(0);
            expect(n, `${name} ${shape.outerHTML}`).toBeLessThanOrEqual(24);
          }
        }
        expect(svg.getAttribute('data-icon')).toBe(
          name
            .slice('Icon'.length)
            .replace(/([a-z])([A-Z])/g, '$1-$2')
            .toLowerCase(),
        );
      });

      it('is decorative by default', () => {
        const { container } = render(createElement(Icon));
        const svg = container.querySelector('svg');
        expect(svg?.getAttribute('aria-hidden')).toBe('true');
        expect(svg?.getAttribute('focusable')).toBe('false');
        expect(svg?.hasAttribute('role')).toBe(false);
      });

      it('becomes a named image when given a label', () => {
        render(createElement(Icon, { label: 'More actions' }));
        const svg = screen.getByRole('img', { name: 'More actions' });
        expect(svg.hasAttribute('aria-hidden')).toBe(false);
      });

      it('takes its size from the icon size tokens, small by default', () => {
        const { container, rerender } = render(createElement(Icon));
        const svg = () => only(container.querySelectorAll('svg'));
        expect(classesOf(svg())).toContain('size-icon-sm');
        for (const size of ['sm', 'md', 'lg'] as const) {
          rerender(createElement(Icon, { size }));
          expect(classesOf(svg()), size).toContain(`size-icon-${size}`);
          expect(svg().hasAttribute('width')).toBe(false);
          expect(svg().hasAttribute('height')).toBe(false);
        }
      });
    });
  }
});
