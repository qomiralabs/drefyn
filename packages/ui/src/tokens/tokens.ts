// The one source for every Drefyn design value. The CSS, Tailwind, DTCG and ECharts files
// in src/generated are written from this object by `pnpm --filter @drefyn/ui tokens`, and a
// test fails when they no longer match.
//
// Colours sit light and dark side by side so a change to one mode is reviewed next to the
// other. Components read roles, never these hexes.

export type Hex = `#${string}`;
export type Mode = 'light' | 'dark';

export interface ModeColor {
  light: Hex;
  dark: Hex;
}

// A translucent colour. Contrast is measured on the colour it composites to over the ground.
export interface Wash {
  light: { base: Hex; alpha: number };
  dark: { base: Hex; alpha: number };
}

export interface ShadowLayer {
  y: number;
  blur: number;
  alpha: number;
}

const color = {
  surface: {
    ground: { light: '#FAFAF9', dark: '#141210' },
    raised: { light: '#F5F5F4', dark: '#1C1A17' },
    sunken: { light: '#F5F5F4', dark: '#24211D' },
  },
  border: {
    rule: { light: '#E7E5E4', dark: '#292524' },
    ruleStrong: { light: '#D6D3D1', dark: '#44403C' },
    control: { light: '#8F8984', dark: '#78716C' },
  },
  text: {
    ink: { light: '#0B1120', dark: '#FAFAF9' },
    body: { light: '#1E293B', dark: '#D6D3D1' },
    secondary: { light: '#475569', dark: '#A8A29E' },
    // Light: on ground only. It measures 4.36 on raised and sunken.
    subtle: { light: '#64748B', dark: '#A8A29E' },
  },
  // Disabled controls paint with these instead of dimming with opacity, so every colour a
  // disabled control shows is one the contrast tests measured. The label stays legible but
  // nothing reaches 3:1, so a disabled control never passes for a live one.
  disabled: {
    fill: { light: '#F5F5F4', dark: '#1C1A17' },
    edge: { light: '#D6D3D1', dark: '#44403C' },
    // Dark was #78716C, the live control edge colour, and measured 3.89. Matching the light
    // band means one rule for both modes.
    text: { light: '#94A3B8', dark: '#57534E' },
  },
  accent: {
    ink: { light: '#4F46E5', dark: '#818CF8' },
    press: { light: '#4338CA', dark: '#A5B4FC' },
    on: { light: '#FFFFFF', dark: '#141210' },
  },
  // Teal means "live right now". The mark is too light to stand alone on paper.
  signal: {
    mark: { light: '#14B8A6', dark: '#14B8A6' },
    text: { light: '#0F766E', dark: '#14B8A6' },
  },
  // Locked: customer themes cannot override state colours.
  state: {
    fresh: {
      mark: { light: '#16A34A', dark: '#4ADE80' },
      text: { light: '#15803D', dark: '#4ADE80' },
    },
    stale: {
      mark: { light: '#F59E0B', dark: '#FBBF24' },
      text: { light: '#B45309', dark: '#FBBF24' },
    },
    broken: {
      mark: { light: '#DC2626', dark: '#F87171' },
      text: { light: '#B91C1C', dark: '#F87171' },
    },
    // Maintenance and no data. The mark carries a hatch drawn in the text colour.
    neutral: {
      mark: { light: '#D6D3D1', dark: '#44403C' },
      text: { light: '#475569', dark: '#A8A29E' },
    },
  },
  focus: {
    ring: { light: '#4F46E5', dark: '#818CF8' },
  },
} as const satisfies Record<string, Record<string, ModeColor | Record<string, ModeColor>>>;

const wash = {
  light: { base: '#4F46E5', alpha: 0.08 },
  // 0.16 left accent.ink at 4.21 where the wash lands on sunken. At 0.10 every reading pair
  // passes on every surface and the wash still sits 1.13 off its surface.
  dark: { base: '#818CF8', alpha: 0.1 },
} as const satisfies Wash;

// Shadows are drawn in ink. Dark mode has none: floating things use the raised surface and a
// strong rule instead, because a shadow on a near black ground reads as dirt.
const shadow = {
  0: { light: [], dark: [] },
  1: {
    light: [
      { y: 1, blur: 2, alpha: 0.06 },
      { y: 8, blur: 24, alpha: 0.1 },
    ],
    dark: [],
  },
  2: { light: [{ y: 16, blur: 48, alpha: 0.16 }], dark: [] },
} as const satisfies Record<number, Record<Mode, readonly ShadowLayer[]>>;

const font = {
  sans: ['Inter', 'Inter fallback', 'ui-sans-serif', 'system-ui', 'sans-serif'],
  mono: ['JetBrains Mono', 'ui-monospace', 'SF Mono', 'Menlo', 'monospace'],
} as const;

const weight = { regular: 400, medium: 500, strong: 600 } as const;

export interface TypeStep {
  size: number; // px at the default root size, shipped in rem
  lineHeight: number;
  tracking: number; // em
  weight: 400 | 500 | 600;
  family: keyof typeof font;
}

const type = {
  displayXl: { size: 72, lineHeight: 1.05, tracking: -0.03, weight: 600, family: 'sans' },
  displayL: { size: 56, lineHeight: 1.08, tracking: -0.025, weight: 600, family: 'sans' },
  displayM: { size: 40, lineHeight: 1.12, tracking: -0.02, weight: 600, family: 'sans' },
  displayS: { size: 28, lineHeight: 1.2, tracking: -0.015, weight: 600, family: 'sans' },
  title: { size: 20, lineHeight: 1.3, tracking: -0.01, weight: 600, family: 'sans' },
  bodyL: { size: 18, lineHeight: 1.6, tracking: 0, weight: 400, family: 'sans' },
  bodyM: { size: 16, lineHeight: 1.6, tracking: 0, weight: 400, family: 'sans' },
  bodyS: { size: 14, lineHeight: 1.55, tracking: 0, weight: 400, family: 'sans' },
  code: { size: 14, lineHeight: 1.6, tracking: 0, weight: 400, family: 'mono' },
  caption: { size: 13, lineHeight: 1.45, tracking: 0, weight: 400, family: 'sans' },
  // Mono caps. The uppercase transform belongs to the component.
  label: { size: 12, lineHeight: 1.2, tracking: 0.12, weight: 500, family: 'mono' },
} as const satisfies Record<string, TypeStep>;

// Named by pixels at the default root size, so a review can ask "why is this 20?". There is no 20.
const space = {
  0: 0,
  2: 2,
  4: 4,
  8: 8,
  12: 12,
  16: 16,
  24: 24,
  32: 32,
  48: 48,
  64: 64,
  96: 96,
  128: 128,
} as const;

// Pixels, not rem: corners and lines should not grow with text.
const radius = { none: 0, xs: 2, sm: 4, md: 6, full: 9999 } as const;
// The gutter is the status gutter beside a docs section, as wide as the brand's status rule.
// The focus offset keeps the ring off the control's own edge.
const stroke = { hairline: 1, focus: 2, focusOffset: 2, icon: 1.5, gutter: 4 } as const;

// Stacking order, named by job. Gaps of ten leave room without renumbering.
const layer = { base: 0, raised: 10, overlay: 20, toast: 30 } as const;

export interface Duration {
  ms: number;
  // A fade only changes opacity or colour; a move changes position or size.
  kind: 'fade' | 'move';
}

const motion = {
  duration: {
    fast: { ms: 120, kind: 'fade' },
    base: { ms: 180, kind: 'fade' },
    slow: { ms: 240, kind: 'fade' },
    moveFast: { ms: 120, kind: 'move' },
    moveBase: { ms: 180, kind: 'move' },
    moveSlow: { ms: 240, kind: 'move' },
    // Website first visit only.
    brandReveal: { ms: 1000, kind: 'move' },
  },
  ease: {
    enter: [0.2, 0, 0, 1],
    exit: [0.4, 0, 1, 1],
  },
  // How far things travel when they appear.
  distance: { enter: 4 },
  // Dashboard only, through Motion. Damping ratio 1.02 so it never overshoots, and it settles
  // in about 238 ms. Under reduced motion the component fades instead.
  spring: { default: { stiffness: 600, damping: 50, mass: 1 } },
} as const satisfies {
  duration: Record<string, Duration>;
  ease: Record<string, readonly [number, number, number, number]>;
  distance: Record<string, number>;
  spring: Record<string, { stiffness: number; damping: number; mass: number }>;
};

// Fades never run longer than this when the reader asks for reduced motion.
export const reducedFadeCapMs = 120;

const layout = {
  pageMax: 1200,
  gutter: { wide: 24, compact: 16 },
  // Below this width the gutter tightens. Tailwind's sm breakpoint is the same width.
  compactBelow: 640,
  measure: 66, // ch
  // The docs site's three columns: navigation, reading, on this page.
  docs: { nav: 240, content: 640, toc: 220 },
} as const;

export const tokens = {
  color,
  wash,
  shadow,
  font,
  weight,
  type,
  space,
  radius,
  stroke,
  layer,
  motion,
  layout,
} as const;

export type Tokens = typeof tokens;
