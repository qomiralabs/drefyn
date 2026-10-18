// Which colour may sit on which, in each mode, and how much contrast it needs. Anything not
// listed here is not an approved combination.

import { composite, contrast, floor2 } from './contrast.ts';
import { tokens, type Hex, type Mode, type ModeColor } from './tokens.ts';

type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends ModeColor ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

export type ColorRole = Leaves<typeof tokens.color>;
// The selection wash is translucent, so it is measured where it lands: over the ground.
export type Backdrop = ColorRole | 'accent.wash';
export type PairKind = 'text' | 'non-text';

export const minimum = { text: 4.5, 'non-text': 3 } as const satisfies Record<PairKind, number>;

export interface PairGroup {
  fg: readonly ColorRole[];
  bg: readonly Backdrop[];
  kind: PairKind;
  modes: readonly Mode[];
  why: string;
}

export interface Pair {
  mode: Mode;
  fg: ColorRole;
  bg: Backdrop;
  kind: PairKind;
  why: string;
}

const BOTH = ['light', 'dark'] as const;
const SURFACES = ['surface.ground', 'surface.raised', 'surface.sunken'] as const;
const READING = [
  'text.ink',
  'text.body',
  'text.secondary',
  'accent.ink',
  'accent.press',
  'signal.text',
  'state.fresh.text',
  'state.stale.text',
  'state.broken.text',
  'state.neutral.text',
] as const;

export const requiredPairs: readonly PairGroup[] = [
  { fg: READING, bg: SURFACES, kind: 'text', modes: BOTH, why: 'Reading text on every surface' },
  {
    fg: ['text.subtle'],
    bg: ['surface.ground'],
    kind: 'text',
    modes: ['light'],
    why: 'Captions, on ground only in light',
  },
  {
    fg: ['text.subtle'],
    bg: SURFACES,
    kind: 'text',
    modes: ['dark'],
    why: 'Captions, on every surface in dark',
  },
  {
    fg: ['text.ink', 'text.body', 'text.secondary', 'accent.ink'],
    bg: ['accent.wash'],
    kind: 'text',
    modes: BOTH,
    why: 'Selected rows and text selection',
  },
  {
    fg: ['accent.on'],
    bg: ['accent.ink', 'accent.press'],
    kind: 'text',
    modes: BOTH,
    why: 'Primary button label, at rest and pressed',
  },
  {
    fg: ['border.control'],
    bg: SURFACES,
    kind: 'non-text',
    modes: BOTH,
    why: 'Input and checkbox edges must be findable',
  },
  {
    fg: ['focus.ring'],
    bg: [...SURFACES, 'accent.wash'],
    kind: 'non-text',
    modes: BOTH,
    why: 'Focus is visible wherever it lands',
  },
  {
    fg: ['state.fresh.mark', 'state.broken.mark'],
    bg: SURFACES,
    kind: 'non-text',
    modes: ['light'],
    why: 'Operational and outage marks in ribbons and pips',
  },
  {
    fg: ['signal.mark', 'state.fresh.mark', 'state.stale.mark', 'state.broken.mark'],
    bg: SURFACES,
    kind: 'non-text',
    modes: ['dark'],
    why: 'Every mark clears 3:1 on a dark ground',
  },
  {
    fg: ['state.neutral.text'],
    bg: ['state.neutral.mark'],
    kind: 'non-text',
    modes: BOTH,
    why: 'The maintenance hatch is drawn over its mark',
  },
];

// Combinations that fail on purpose. Tests assert they still fail, so the rule they stand for
// cannot be removed by deleting a line from the table above.
export const forbiddenPairs: readonly PairGroup[] = [
  {
    fg: ['text.subtle'],
    bg: ['surface.raised', 'surface.sunken'],
    kind: 'text',
    modes: ['light'],
    why: 'Subtle text is for the ground only in light',
  },
  {
    fg: ['state.stale.mark', 'signal.mark'],
    bg: ['surface.ground'],
    kind: 'non-text',
    modes: ['light'],
    why: 'Amber and teal marks always sit beside a word or a tick in their text colour',
  },
  {
    fg: ['state.fresh.text', 'state.stale.text', 'text.subtle'],
    bg: ['accent.wash'],
    kind: 'text',
    modes: ['light'],
    why: 'A selected row shows state with its icon and ink text, never coloured text',
  },
  {
    fg: ['border.control'],
    bg: ['accent.wash'],
    kind: 'non-text',
    modes: ['light'],
    why: 'A selected row draws its edge from the rule token',
  },
];

// Combinations that measure fine but are never used, so a rule reads the same in both modes.
// Components treat these exactly like the forbidden pairs.
export const ruledOutPairs: readonly PairGroup[] = [
  {
    fg: ['state.broken.text', 'state.neutral.text'],
    bg: ['accent.wash'],
    kind: 'text',
    modes: ['light'],
    why: 'A selected row shows state with its icon and ink text, never coloured text',
  },
  {
    fg: [
      'state.fresh.text',
      'state.stale.text',
      'state.broken.text',
      'state.neutral.text',
      'text.subtle',
    ],
    bg: ['accent.wash'],
    kind: 'text',
    modes: ['dark'],
    why: 'A selected row shows state with its icon and ink text, never coloured text',
  },
  {
    fg: ['border.control'],
    bg: ['accent.wash'],
    kind: 'non-text',
    modes: ['dark'],
    why: 'A selected row draws its edge from the rule token',
  },
];

// Disabled controls are exempt from the WCAG minimums, but they still have to be findable and
// must never pass for live ones. Each pair sits at or above its floor and below this ceiling,
// which is the live minimum for marks and control edges.
export const disabledCeiling = minimum['non-text'];

export interface DisabledGroup extends PairGroup {
  floor: number;
}

export const disabledPairs: readonly DisabledGroup[] = [
  {
    fg: ['disabled.text'],
    bg: ['disabled.fill', ...SURFACES],
    kind: 'text',
    modes: BOTH,
    floor: 2,
    why: 'A disabled label can still be made out and never reads as live text',
  },
  {
    fg: ['disabled.edge'],
    bg: ['disabled.fill', ...SURFACES],
    kind: 'non-text',
    modes: BOTH,
    // About what a strong rule shows on paper: the shape is there, the control is not live.
    floor: 1.3,
    why: 'A disabled input keeps its shape but never draws a live edge',
  },
];

export function expandPairs(groups: readonly PairGroup[]): Pair[] {
  return groups.flatMap((g) =>
    g.modes.flatMap((mode) =>
      g.fg.flatMap((fg) => g.bg.map((bg) => ({ mode, fg, bg, kind: g.kind, why: g.why }))),
    ),
  );
}

export function colorOf(role: Backdrop, mode: Mode): Hex {
  if (role === 'accent.wash') {
    const wash = tokens.wash[mode];
    return composite(wash.base, wash.alpha, tokens.color.surface.ground[mode]);
  }
  let node: unknown = tokens.color;
  for (const part of role.split('.')) node = (node as Record<string, unknown>)[part];
  return (node as ModeColor)[mode];
}

// Floored to two decimals, the way every ratio in review is quoted.
export function measure(
  pair: { fg: ColorRole; bg: Backdrop; kind?: PairKind },
  mode: Mode,
): number {
  return floor2(contrast(colorOf(pair.fg, mode), colorOf(pair.bg, mode)));
}
