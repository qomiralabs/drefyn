import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Badge, StatusDot, StatusPip } from '../../src/react/index.ts';
import { classesOf, FORBIDDEN_LOOKS, only, rootOf } from './classes.ts';

afterEach(cleanup);

const STATES = ['fresh', 'stale', 'broken', 'neutral'] as const;
type State = (typeof STATES)[number];

// Each state has its own shape, so state never rests on colour alone.
const SHAPE: Record<State, string> = {
  fresh: 'check',
  stale: 'clock',
  broken: 'cross',
  neutral: 'hatch',
};

// The icon colour per state. Amber fails 3:1 on paper and the neutral mark is not measured
// on surfaces, so both draw in their text colour.
const ICON_COLOUR: Record<State, string> = {
  fresh: 'text-state-fresh-mark',
  stale: 'text-state-stale-text',
  broken: 'text-state-broken-mark',
  neutral: 'text-state-neutral-text',
};

const WORD: Record<State, string> = {
  fresh: 'Verified 2 days ago',
  stale: 'Out of date',
  broken: 'Wrong',
  neutral: 'Maintenance',
};

const svgIn = (el: Element) => only(el.querySelectorAll('svg'));

describe('Badge', () => {
  for (const state of STATES) {
    it(`shows the ${state} word beside its own shape`, () => {
      const { container } = render(<Badge state={state}>{WORD[state]}</Badge>);
      const root = rootOf(container);
      expect(root.textContent).toBe(WORD[state]);
      expect(root.getAttribute('data-state')).toBe(state);
      const svg = svgIn(root);
      expect(svg.getAttribute('data-icon')).toBe(SHAPE[state]);
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(classesOf(svg)).toContain(ICON_COLOUR[state]);
      expect(screen.getByText(WORD[state])).toBeDefined();
    });

    it(`sets the ${state} word in its state text on a surface, and in body text on a fill`, () => {
      const { container, rerender } = render(<Badge state={state}>{WORD[state]}</Badge>);
      const root = () => rootOf(container);
      expect(classesOf(root())).toContain(`text-state-${state}-text`);
      rerender(
        <Badge state={state} onFill>
          {WORD[state]}
        </Badge>,
      );
      expect(classesOf(root())).toContain('text-body');
      expect(classesOf(root()).filter((c) => c.startsWith('text-state-'))).toEqual([]);
      // The icon keeps its colour on a fill; the word carries the meaning.
      expect(classesOf(svgIn(root()))).toContain(ICON_COLOUR[state]);
    });
  }

  it('has no pill fill and never animates', () => {
    const { container } = render(<Badge state="broken">Wrong</Badge>);
    const root = rootOf(container);
    const classes = classesOf(root);
    expect(classes.filter((c) => c.startsWith('bg-'))).toEqual([]);
    for (const pattern of FORBIDDEN_LOOKS) {
      expect(classes.filter((c) => pattern.test(c))).toEqual([]);
    }
  });

  it('takes the word as a string, so a component or fragment cannot stand in for it', () => {
    const span = <span>Fresh</span>;
    // @ts-expect-error The word is plain text.
    const badge = <Badge state="fresh" children={span} />;
    expect(badge).toBeDefined();
  });

  it('refuses an empty word', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const word of ['', '   ']) {
      expect(() => render(<Badge state="broken">{word}</Badge>), JSON.stringify(word)).toThrow(
        /word/i,
      );
      cleanup();
    }
  });
});

describe('StatusPip', () => {
  for (const state of STATES) {
    it(`is an image named by its label, drawn in the ${state} shape`, () => {
      render(<StatusPip state={state} label={WORD[state]} />);
      const pip = screen.getByRole('img', { name: WORD[state] });
      expect(pip.getAttribute('data-state')).toBe(state);
      const svg = svgIn(pip);
      expect(svg.getAttribute('data-icon')).toBe(SHAPE[state]);
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(classesOf(svg)).toContain(ICON_COLOUR[state]);
    });
  }

  it('shows no word, so the name is its only text alternative', () => {
    render(<StatusPip state="fresh" label="Operational" />);
    expect(screen.getByRole('img', { name: 'Operational' }).textContent).toBe('');
  });

  it('cannot be rendered without a name', () => {
    // @ts-expect-error A pip without a name would carry state by colour and shape alone.
    const pip = <StatusPip state="fresh" />;
    expect(pip).toBeDefined();
  });

  it('refuses an empty name, which would leave the shape unnamed', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const label of ['', '   ']) {
      expect(
        () => render(<StatusPip state="fresh" label={label} />),
        JSON.stringify(label),
      ).toThrow(/label|word/i);
      cleanup();
    }
  });

  it('never animates', () => {
    render(<StatusPip state="broken" label="Major outage" />);
    const pip = screen.getByRole('img', { name: 'Major outage' });
    for (const el of [pip, ...pip.querySelectorAll('*')]) {
      for (const pattern of FORBIDDEN_LOOKS) {
        expect(classesOf(el).filter((c) => pattern.test(c))).toEqual([]);
      }
    }
  });
});

describe('StatusDot', () => {
  const DOT: Record<State | 'live', string> = {
    fresh: 'bg-state-fresh-mark',
    stale: 'bg-state-stale-mark',
    broken: 'bg-state-broken-mark',
    neutral: 'bg-state-neutral-mark',
    live: 'bg-signal-mark',
  };

  for (const state of [...STATES, 'live'] as const) {
    it(`shows the word beside a ${state} dot that screen readers skip`, () => {
      const word = state === 'live' ? 'Syncing' : WORD[state];
      const { container } = render(<StatusDot state={state}>{word}</StatusDot>);
      const root = rootOf(container);
      expect(root.getAttribute('data-state')).toBe(state);
      expect(root.textContent).toBe(word);
      const hidden = root.querySelectorAll('[aria-hidden="true"]');
      expect(hidden).toHaveLength(1);
      const dot = hidden[0] as HTMLElement;
      expect(dot.textContent).toBe('');
      expect(classesOf(dot)).toEqual(expect.arrayContaining([DOT[state], 'rounded-full']));
    });
  }

  it('cannot be rendered without its word', () => {
    // @ts-expect-error Amber and teal dots never stand alone.
    const dot = <StatusDot state="live" />;
    expect(dot).toBeDefined();
  });

  it('is static: no pulse, no transition', () => {
    const { container } = render(<StatusDot state="live">3 viewing</StatusDot>);
    for (const el of container.querySelectorAll('*')) {
      expect(classesOf(el).filter((c) => /(^|:)(animate-|transition)/.test(c))).toEqual([]);
    }
  });

  it('takes the word as a string, so a component or fragment cannot stand in for it', () => {
    const data = <data value="3">3</data>;
    // @ts-expect-error The word is plain text.
    const dot = <StatusDot state="live" children={data} />;
    expect(dot).toBeDefined();
  });

  it('refuses an empty word', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const word of ['', '   ']) {
      expect(
        () => render(<StatusDot state="live">{word}</StatusDot>),
        JSON.stringify(word),
      ).toThrow(/word/i);
      cleanup();
    }
  });
});
