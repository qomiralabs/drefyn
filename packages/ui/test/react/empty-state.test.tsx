import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Button, EmptyState, IconCheck } from '../../src/react/index.ts';
import { classesOf, only, rootOf } from './classes.ts';

afterEach(cleanup);

const SENTENCE =
  'A component is one thing your customers rely on, such as an API or a checkout page.';

describe('EmptyState', () => {
  it('names the place with a heading, then one sentence, then the action', () => {
    const { container } = render(
      <EmptyState
        title="No components yet"
        action={<Button variant="primary">Add component</Button>}
      >
        {SENTENCE}
      </EmptyState>,
    );
    const heading = screen.getByRole('heading', { level: 2, name: 'No components yet' });
    const sentence = screen.getByText(SENTENCE);
    const action = screen.getByRole('button', { name: 'Add component' });
    const order = [...rootOf(container).querySelectorAll('*')];
    expect(order.indexOf(heading)).toBeLessThan(order.indexOf(sentence));
    expect(order.indexOf(sentence)).toBeLessThan(order.indexOf(action));
  });

  it('sets the heading level the page needs', () => {
    render(
      <EmptyState title="No pages match 'stale'" headingLevel={3}>
        Clear the filter to see every page.
      </EmptyState>,
    );
    expect(screen.getByRole('heading', { level: 3, name: "No pages match 'stale'" })).toBeDefined();
  });

  it('lets a caller move focus to the heading after an error replaces content', () => {
    render(
      <EmptyState title="Could not load components" tone="error">
        The request timed out. Nothing was changed.
      </EmptyState>,
    );
    const heading = screen.getByRole('heading', { name: 'Could not load components' });
    expect(heading.getAttribute('tabindex')).toBe('-1');
    heading.focus();
    expect(document.activeElement).toBe(heading);
  });

  it('is content, not a live region', () => {
    const { container } = render(
      <EmptyState title="Could not load components" tone="error">
        The request timed out.
      </EmptyState>,
    );
    expect(container.querySelectorAll('[role="alert"], [role="status"], [aria-live]')).toHaveLength(
      0,
    );
  });

  it('marks an error with the broken icon only; the title stays ink', () => {
    const { container } = render(
      <EmptyState title="Could not load components" tone="error">
        The request timed out.
      </EmptyState>,
    );
    const icon = only(rootOf(container).querySelectorAll('svg'));
    expect(icon.getAttribute('data-icon')).toBe('alert');
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(classesOf(icon)).toContain('text-state-broken-mark');
    const heading = screen.getByRole('heading', { name: 'Could not load components' });
    expect(classesOf(heading)).toContain('text-ink');
    expect(classesOf(heading).filter((c) => c.includes('state-'))).toEqual([]);
  });

  it('draws an empty state in secondary, never in a state colour', () => {
    const { container } = render(
      <EmptyState title="No components yet" icon={<IconCheck size="lg" />}>
        {SENTENCE}
      </EmptyState>,
    );
    const root = rootOf(container);
    for (const el of [root, ...root.querySelectorAll('*')]) {
      expect(classesOf(el).filter((c) => c.includes('state-'))).toEqual([]);
    }
    expect(root.querySelectorAll('svg')).toHaveLength(1);
  });

  it('shows the request id as code for support', () => {
    render(
      <EmptyState title="Could not load components" tone="error" reference="req_8f2a91">
        The request timed out.
      </EmptyState>,
    );
    const code = screen.getByText('req_8f2a91');
    expect(code.tagName).toBe('CODE');
  });

  it('renders no action when none is given', () => {
    render(<EmptyState title="No incidents">Nothing has gone wrong in 90 days.</EmptyState>);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });
});
