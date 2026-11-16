// Which colour may sit on which, in each mode, and how much contrast it needs. Anything not
// listed here is not an approved combination.

import { composite, contrast, floor2 } from './contrast.ts';
import { tokens, type Hex, type Mode, type ModeColor } from './tokens.ts';

type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends ModeColor ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

export type ColorRole = Leaves<typeof tokens.color>;
// The selection wash is translucent, so it is measured over each surface it can land on.
export const washBackdrops = [
  'accent.wash@ground',
  'accent.wash@raised',
  'accent.wash@sunken',
] as const;
export type WashBackdrop = (typeof washBackdrops)[number];
export type Backdrop = ColorRole | WashBackdrop;
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
const FILLS = ['surface.hover', 'surface.pressed'] as const;

export const requiredPairs: readonly PairGroup[] = [
  {
    fg: ['meter.fill'],
    bg: ['meter.track', 'surface.ground'],
    kind: 'non-text',
    modes: BOTH,
    why: 'A usage meter is read from its fill, against its track and the page',
  },
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
    bg: washBackdrops,
    kind: 'text',
    modes: BOTH,
    why: 'Selected rows and text selection, on any surface',
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
    bg: [...SURFACES, ...washBackdrops],
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
  {
    fg: ['accent.ink'],
    bg: [...SURFACES, ...washBackdrops],
    kind: 'non-text',
    modes: BOTH,
    why: 'The indicator bar on a selected row, the current nav item and the selected tab',
  },
  // State words on anything that can be hovered or pressed are body text beside the state
  // icon (see supplementaryMarks). Red and grey state text still pass, for the sentence that
  // explains an error.
  {
    fg: [
      'text.ink',
      'text.body',
      'text.secondary',
      'accent.ink',
      'accent.press',
      'state.broken.text',
      'state.neutral.text',
    ],
    bg: ['surface.hover'],
    kind: 'text',
    modes: BOTH,
    why: 'Menu items, options and rows under the pointer',
  },
  {
    fg: ['signal.text'],
    bg: ['surface.hover'],
    kind: 'text',
    modes: ['dark'],
    why: 'Live labels under the pointer in dark',
  },
  {
    fg: ['text.ink', 'text.body', 'text.secondary', 'accent.ink'],
    bg: ['surface.pressed'],
    kind: 'text',
    modes: BOTH,
    why: 'Menu items, options and rows while pressed',
  },
  {
    fg: ['border.control'],
    bg: ['surface.hover'],
    kind: 'non-text',
    modes: BOTH,
    why: 'A hovered field keeps a findable edge',
  },
  {
    fg: ['focus.ring'],
    bg: FILLS,
    kind: 'non-text',
    modes: BOTH,
    why: 'The inset ring is drawn over the fill of the item it marks',
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
    bg: washBackdrops,
    kind: 'text',
    modes: ['light'],
    why: 'A selected row shows state with its icon and ink text, never coloured text',
  },
  {
    fg: ['border.control'],
    bg: washBackdrops,
    kind: 'non-text',
    modes: ['light'],
    why: 'A selected row draws its edge from the rule token',
  },
  {
    fg: ['border.control'],
    bg: ['accent.wash@sunken'],
    kind: 'non-text',
    modes: ['dark'],
    why: 'A selected row draws its edge from the rule token',
  },
  {
    fg: ['state.fresh.text', 'state.stale.text', 'text.subtle'],
    bg: FILLS,
    kind: 'text',
    modes: ['light'],
    why: 'A hovered or pressed item shows state with its icon and body text, never coloured text',
  },
  {
    fg: ['border.control'],
    bg: ['surface.pressed'],
    kind: 'non-text',
    modes: BOTH,
    why: 'A pressed element never draws a control edge',
  },
  {
    fg: ['disabled.text'],
    bg: FILLS,
    kind: 'text',
    modes: BOTH,
    why: 'Disabled items never take the hover or pressed fill',
  },
];

// Combinations that measure fine but are never used, so a rule reads the same in both modes.
// Components treat these exactly like the forbidden pairs.
export const ruledOutPairs: readonly PairGroup[] = [
  {
    fg: ['state.broken.text', 'state.neutral.text'],
    bg: washBackdrops,
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
    bg: washBackdrops,
    kind: 'text',
    modes: ['dark'],
    why: 'A selected row shows state with its icon and ink text, never coloured text',
  },
  {
    fg: ['border.control'],
    bg: ['accent.wash@ground', 'accent.wash@raised'],
    kind: 'non-text',
    modes: ['dark'],
    why: 'A selected row draws its edge from the rule token',
  },
  {
    fg: ['state.broken.text', 'state.neutral.text'],
    bg: ['surface.pressed'],
    kind: 'text',
    modes: ['light'],
    why: 'A hovered or pressed item shows state with its icon and body text, never coloured text',
  },
  {
    fg: ['state.fresh.text', 'state.stale.text', 'text.subtle'],
    bg: FILLS,
    kind: 'text',
    modes: ['dark'],
    why: 'A hovered or pressed item shows state with its icon and body text, never coloured text',
  },
  {
    fg: ['state.broken.text', 'state.neutral.text'],
    bg: ['surface.pressed'],
    kind: 'text',
    modes: ['dark'],
    why: 'A hovered or pressed item shows state with its icon and body text, never coloured text',
  },
];

// State icons on the hover and pressed fills. Each sits beside its state word in body text,
// which carries the meaning, so the icon is supplementary and no 3:1 minimum applies; it keeps
// its mark colour. Light green measures 2.89 on hover. A mark with no word beside it never
// takes either fill. The ratios are pinned in the tests so a change is still seen in review.
export const supplementaryMarks: readonly PairGroup[] = [
  {
    fg: ['state.fresh.mark', 'state.stale.mark', 'state.broken.mark', 'state.neutral.mark'],
    bg: FILLS,
    kind: 'non-text',
    modes: BOTH,
    why: 'A state icon beside its word on a hovered or pressed item',
  },
];

// How far the hover and pressed fills must sit off the surface under them, and where they may
// go. Light raised is the weakest allowed backdrop at 1.04. Dark sunken is 1.02, so interactive
// items never sit on sunken, in either mode, so the rule reads the same wherever it is built.
export const fillFloor = 1.04;

export const fillBackdrops = {
  allowed: ['surface.ground', 'surface.raised', 'surface.overlay'],
  never: ['surface.sunken'],
  why: 'Interactive items never sit on sunken: the dark hover fill is only 1.02 off it',
} as const satisfies {
  allowed: readonly ColorRole[];
  never: readonly ColorRole[];
  why: string;
};

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

// Roles that never carry meaning on their own, so no contrast minimum applies. Anything else
// must appear in a pair group above; a test holds both lists to the tokens.
export const decorativeRoles: readonly { role: ColorRole; why: string }[] = [
  {
    role: 'border.rule',
    why: 'Hairlines that group content; the content carries its own contrast',
  },
  {
    role: 'border.ruleStrong',
    why: 'Chart grid and card borders; an input edge that must be found uses border.control',
  },
  {
    role: 'skeleton.fill',
    why: 'Placeholder blocks while content loads; never under text',
  },
];

// Roles that are another role under a new name, so they need no pairs of their own: every
// pair on the role they resolve to already covers them, and a test holds the hexes equal.
export const aliasRoles: readonly {
  role: ColorRole;
  resolves: Record<Mode, ColorRole>;
  why: string;
}[] = [
  {
    role: 'surface.overlay',
    resolves: { light: 'surface.ground', dark: 'surface.raised' },
    why: 'Floating things are paper with a shadow in light, raised with the strong rule in dark',
  },
  {
    role: 'meter.track',
    resolves: { light: 'border.rule', dark: 'border.rule' },
    why: 'A usage meter track is a hairline drawn wide; plan limits never take a state colour',
  },
  {
    role: 'meter.fill',
    resolves: { light: 'text.secondary', dark: 'text.secondary' },
    why: 'A usage meter fill is secondary ink at every level, so a limit never reads as health',
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
  if (role.startsWith('accent.wash@')) {
    const wash = tokens.wash[mode];
    const under = role.slice('accent.wash@'.length) as keyof typeof tokens.color.surface;
    return composite(wash.base, wash.alpha, tokens.color.surface[under][mode]);
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

// The docs family, the reader palette on published docs sites. Measured on its own grounds,
// never against the paper family, because a docs page never mixes the two.
export type DocsRole = Leaves<typeof tokens.docs.color>;
export type DocsWash = keyof typeof tokens.docs.wash;
export type DocsBackdrop = DocsRole | `wash.${DocsWash}@${DocsRole}`;

export interface DocsPairGroup {
  fg: readonly DocsRole[];
  bg: readonly DocsBackdrop[];
  kind: PairKind;
  modes: readonly Mode[];
  why: string;
}

export interface DocsPair {
  mode: Mode;
  fg: DocsRole;
  bg: DocsBackdrop;
  kind: PairKind;
  why: string;
}

function rolesOf(node: unknown, path: string[] = []): string[] {
  if (typeof node === 'object' && node !== null && 'light' in node) return [path.join('.')];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
    rolesOf(v, [...path, k]),
  );
}

export const docsRoles = rolesOf(tokens.docs.color) as DocsRole[];

const DOCS_SURFACES = [
  'surface.ground',
  'surface.raised',
  'surface.sunken',
  'surface.hover',
  'surface.overlay',
  'surface.card',
  'surface.chip',
] as const;
const DOCS_READING = [
  'text.ink',
  'text.body',
  'text.secondary',
  'text.subtle',
  'accent.ink',
  'accent.press',
  'state.fresh.text',
  'state.stale.text',
  'state.broken.text',
  'state.neutral.text',
] as const;
const DOCS_CODE = [
  'code.text',
  'code.key',
  'code.str',
  'code.num',
  'code.kw',
  'code.com',
  'code.flag',
] as const;
const DOCS_WASHES = [
  'wash.accent@surface.ground',
  'wash.accent@surface.raised',
  'wash.accent@surface.card',
  'wash.info@surface.ground',
  'wash.info@surface.card',
  'wash.stale@surface.ground',
  'wash.stale@surface.card',
] as const;
const METHODS = ['get', 'post', 'patch', 'delete', 'graphql'] as const;

export const docsPairs: readonly DocsPairGroup[] = [
  {
    fg: DOCS_READING,
    bg: DOCS_SURFACES,
    kind: 'text',
    modes: BOTH,
    why: 'Reading text on every docs surface',
  },
  {
    fg: ['accent.on'],
    bg: ['accent.ink', 'accent.press'],
    kind: 'text',
    modes: BOTH,
    why: 'Primary button label, at rest and pressed',
  },
  {
    fg: ['border.control', 'focus.ring'],
    bg: DOCS_SURFACES,
    kind: 'non-text',
    modes: BOTH,
    why: 'Field edges are findable and focus is visible wherever it lands',
  },
  {
    fg: DOCS_CODE,
    bg: ['code.bg', 'wash.codeHit@code.bg'],
    kind: 'text',
    modes: BOTH,
    why: 'Every code colour reads on the block and on the line a field points at',
  },
  ...METHODS.map((m): DocsPairGroup => ({
    fg: [`method.${m}`],
    bg: [`method.${m}Fill`, ...DOCS_SURFACES],
    kind: 'text',
    modes: BOTH,
    why: 'The method word on its soft pill, and bare in breadcrumbs and lists',
  })),
  {
    fg: ['method.on'],
    bg: METHODS.map((m): DocsRole => `method.${m}`),
    kind: 'text',
    modes: BOTH,
    why: 'The method word on the solid pill of the active row',
  },
  {
    fg: ['required.text'],
    bg: ['required.fill', ...DOCS_SURFACES],
    kind: 'text',
    modes: BOTH,
    why: 'The required badge, on its fill and bare',
  },
  {
    fg: ['text.ink', 'text.body', 'text.secondary', 'accent.ink'],
    bg: DOCS_WASHES,
    kind: 'text',
    modes: BOTH,
    why: 'The current nav row, notes and stale notices over the ground and cards',
  },
  {
    fg: ['focus.ring'],
    bg: DOCS_WASHES,
    kind: 'non-text',
    modes: BOTH,
    why: 'Focus stays visible on a washed row',
  },
];

export const docsDecorativeRoles: readonly { role: DocsRole; why: string }[] = [
  { role: 'border.rule', why: 'Hairlines that group content; the content carries its contrast' },
  { role: 'border.ruleStrong', why: 'Card and frame edges; a field edge uses border.control' },
  { role: 'skeleton.fill', why: 'Placeholder blocks while content loads; never under text' },
];

export function expandDocsPairs(groups: readonly DocsPairGroup[]): DocsPair[] {
  return groups.flatMap((g) =>
    g.modes.flatMap((mode) =>
      g.fg.flatMap((fg) => g.bg.map((bg) => ({ mode, fg, bg, kind: g.kind, why: g.why }))),
    ),
  );
}

export function docsColorOf(role: DocsBackdrop, mode: Mode): Hex {
  const at = role.indexOf('@');
  if (at !== -1) {
    const wash = tokens.docs.wash[role.slice('wash.'.length, at) as DocsWash][mode];
    return composite(wash.base, wash.alpha, docsColorOf(role.slice(at + 1) as DocsRole, mode));
  }
  let node: unknown = tokens.docs.color;
  for (const part of role.split('.')) node = (node as Record<string, unknown>)[part];
  return (node as ModeColor)[mode];
}

export function measureDocs(pair: { fg: DocsRole; bg: DocsBackdrop }, mode: Mode): number {
  return floor2(contrast(docsColorOf(pair.fg, mode), docsColorOf(pair.bg, mode)));
}
