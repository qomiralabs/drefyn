// Renders the token source into the four shipped formats. Pure string building with no
// dependencies, so the output is the same on every machine and a byte diff means drift.

import {
  reducedFadeCapMs,
  tokens as source,
  type Hex,
  type Mode,
  type ModeColor,
  type ShadowLayer,
  type Tokens,
} from './tokens.ts';

const HEADER =
  'Generated from src/tokens/tokens.ts by `pnpm --filter @drefyn/ui tokens`. Do not edit by hand.';

export const fontFaces = [
  { family: 'Inter', weight: 400, file: 'inter-latin-400-normal.woff2' },
  { family: 'Inter', weight: 500, file: 'inter-latin-500-normal.woff2' },
  { family: 'Inter', weight: 600, file: 'inter-latin-600-normal.woff2' },
  { family: 'JetBrains Mono', weight: 400, file: 'jetbrains-mono-latin-400-normal.woff2' },
  { family: 'JetBrains Mono', weight: 500, file: 'jetbrains-mono-latin-500-normal.woff2' },
] as const;

// Arial stretched to Inter's metrics, so text does not reflow when Inter arrives.
const interFallback = {
  local: 'Arial',
  sizeAdjust: '107.4%',
  ascent: '90.2%',
  descent: '22.48%',
  lineGap: '0%',
};

const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'system-ui',
  'ui-sans-serif',
  'ui-monospace',
]);

type Entry = [name: string, value: string];

// What may still fade when the reader asks for reduced motion: colour, opacity and shadow.
const REDUCED_TRANSITION = [
  'color',
  'background-color',
  'border-color',
  'outline-color',
  'text-decoration-color',
  'fill',
  'stroke',
  'opacity',
  'box-shadow',
];

const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const rem = (px: number) => (px === 0 ? '0' : `${px / 16}rem`);
const px = (n: number) => (n === 0 ? '0' : `${n}px`);
const isModeColor = (v: unknown): v is ModeColor =>
  typeof v === 'object' && v !== null && 'light' in v && typeof v.light === 'string';

// Colours go straight into CSS and are split into channels below, so a short or malformed
// hex would ship a wrong colour or break out of its declaration. Reject, never repair.
function checked(hex: string): Hex {
  if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) throw new Error(`${hex} is not a #RRGGBB colour`);
  return hex as Hex;
}

// Names become CSS custom properties, utility names and JSON keys once kebab cased.
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// The only numbers that may go below zero: letter spacing, because display type is set
// tight, and the inset focus offset, which pulls the ring inside an item's own edge.
const SIGNED = /^(type\.[^.]+\.tracking|stroke\.focusInset)$/;

// Walks the whole source once before anything is written, so a bad value fails the build
// with its path instead of shipping NaNpx, a negative width or a name that breaks a rule.
function validate(node: unknown, path: string[] = []): void {
  const where = path.join('.');
  if (typeof node === 'number') {
    if (!Number.isFinite(node)) throw new Error(`${where} is ${node}, not a finite number`);
    if (node < 0 && !SIGNED.test(where)) throw new Error(`${where} is ${node}, below zero`);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const list = Array.isArray(node);
  for (const [key, child] of Object.entries(node)) {
    if (!list && !NAME.test(kebab(key))) {
      throw new Error(`"${key}" at ${where || 'the top'} is not a valid token name`);
    }
    validate(child, [...path, key]);
  }
}

function channels(hex: Hex): [number, number, number] {
  const n = parseInt(checked(hex).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgb(hex: Hex, alpha: number): string {
  const [r, g, b] = channels(hex);
  return `rgb(${r} ${g} ${b} / ${alpha})`;
}

function family(names: readonly string[]): string {
  return names.map((n) => (GENERIC_FAMILIES.has(n) ? n : `"${n}"`)).join(', ');
}

function shadow(layers: readonly ShadowLayer[], ink: Hex): string {
  if (layers.length === 0) return 'none';
  return layers.map((l) => `0 ${px(l.y)} ${px(l.blur)} ${rgb(ink, l.alpha)}`).join(', ');
}

function cubicBezier(points: readonly number[]): string {
  return `cubic-bezier(${points.join(', ')})`;
}

// Every role that changes with the mode, as [css name, value].
function modeEntries(t: Tokens, mode: Mode): Entry[] {
  const entries: Entry[] = [];
  const walk = (node: unknown, path: string[]) => {
    if (isModeColor(node)) {
      entries.push([`--dr-${path.map(kebab).join('-')}`, checked(node[mode])]);
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      walk(child, [...path, key]);
    }
    if (path.length === 1 && path[0] === 'accent') {
      entries.push(['--dr-accent-wash', rgb(t.wash[mode].base, t.wash[mode].alpha)]);
    }
  };
  walk(t.color, []);
  for (const [k, w] of Object.entries(t.overlay)) {
    entries.push([`--dr-overlay-${kebab(k)}`, rgb(w[mode].base, w[mode].alpha)]);
  }
  for (const [level, layers] of Object.entries(t.shadow)) {
    entries.push([`--dr-shadow-${level}`, shadow(layers[mode], t.color.text.ink.light)]);
  }
  return entries;
}

function sharedEntries(t: Tokens): Entry[] {
  const entries: Entry[] = [
    ['--dr-font-sans', family(t.font.sans)],
    ['--dr-font-mono', family(t.font.mono)],
  ];
  for (const [step, s] of Object.entries(t.type)) {
    const name = `--dr-type-${kebab(step)}`;
    entries.push([name, `${s.weight} ${rem(s.size)}/${s.lineHeight} var(--dr-font-${s.family})`]);
    entries.push([`${name}-tracking`, `${s.tracking}em`]);
  }
  for (const [k, v] of Object.entries(t.weight)) entries.push([`--dr-weight-${k}`, String(v)]);
  entries.push(['--dr-measure', `${t.layout.measure}em`]);
  for (const [k, v] of Object.entries(t.space)) entries.push([`--dr-space-${k}`, rem(v)]);
  for (const [group, steps] of Object.entries(t.size)) {
    for (const [k, v] of Object.entries(steps)) {
      entries.push([`--dr-size-${group}-${kebab(k)}`, rem(v)]);
    }
  }
  for (const [k, v] of Object.entries(t.radius)) entries.push([`--dr-radius-${k}`, px(v)]);
  for (const [k, v] of Object.entries(t.stroke)) entries.push([`--dr-stroke-${kebab(k)}`, px(v)]);
  for (const [k, v] of Object.entries(t.layer)) entries.push([`--dr-layer-${k}`, String(v)]);
  for (const [k, d] of Object.entries(t.motion.duration)) {
    entries.push([`--dr-duration-${kebab(k)}`, `${d.ms}ms`]);
  }
  for (const [k, v] of Object.entries(t.motion.ease)) {
    entries.push([`--dr-ease-${kebab(k)}`, cubicBezier(v)]);
  }
  for (const [k, v] of Object.entries(t.motion.distance)) {
    entries.push([`--dr-distance-${kebab(k)}`, `${v}px`]);
  }
  for (const [k, v] of Object.entries(t.timer))
    entries.push([`--dr-timer-${kebab(k)}`, `${v.ms}ms`]);
  entries.push(['--dr-page-max', px(t.layout.pageMax)]);
  for (const [k, v] of Object.entries(t.layout.docs)) entries.push([`--dr-docs-${k}`, px(v)]);
  for (const [k, v] of Object.entries(t.layout.shell)) {
    entries.push([`--dr-shell-${kebab(k)}`, rem(v)]);
  }
  entries.push(['--dr-gutter', rem(t.layout.gutter.wide)]);
  return entries;
}

// Nothing travels and no fade runs past the cap. Derived from each duration's kind, so a new
// token gets the right reduced value without anyone remembering to add it.
function reducedEntries(t: Tokens): Entry[] {
  const entries: Entry[] = [];
  for (const [k, d] of Object.entries(t.motion.duration)) {
    const reduced = d.kind === 'move' ? 0 : Math.min(d.ms, reducedFadeCapMs);
    if (reduced !== d.ms) entries.push([`--dr-duration-${kebab(k)}`, `${reduced}ms`]);
  }
  for (const k of Object.keys(t.motion.distance)) {
    entries.push([`--dr-distance-${kebab(k)}`, '0px']);
  }
  return entries;
}

function block(selector: string, lines: string[], indent = ''): string {
  return `${indent}${selector} {\n${lines.map((l) => `${indent}  ${l};\n`).join('')}${indent}}\n`;
}

const declarations = (entries: Entry[]) => entries.map(([n, v]) => `${n}: ${v}`);

export function renderTokensCss(t: Tokens = source): string {
  validate(t);
  const faces = fontFaces.map((f) =>
    block('@font-face', [
      `font-family: "${f.family}"`,
      'font-style: normal',
      `font-weight: ${f.weight}`,
      'font-display: swap',
      `src: url("../fonts/${f.file}") format("woff2")`,
    ]),
  );
  faces.push(
    block('@font-face', [
      'font-family: "Inter fallback"',
      `src: local("${interFallback.local}")`,
      `size-adjust: ${interFallback.sizeAdjust}`,
      `ascent-override: ${interFallback.ascent}`,
      `descent-override: ${interFallback.descent}`,
      `line-gap-override: ${interFallback.lineGap}`,
    ]),
  );
  const dark = ['color-scheme: dark', ...declarations(modeEntries(t, 'dark'))];
  return [
    `/* ${HEADER} */\n`,
    ...faces,
    block(':root', [
      'color-scheme: light',
      ...declarations(modeEntries(t, 'light')),
      ...declarations(sharedEntries(t)),
    ]),
    // Numbers line up in tables, times and counters. :where keeps it overridable.
    block(':where(time, data, output, td, th, [data-numeric])', [
      'font-variant-numeric: tabular-nums',
    ]),
    // Strictly below: Tailwind's sm starts at the same width, and both must not apply at once.
    `@media (width < ${rem(t.layout.compactBelow)}) {\n`,
    block(':root', [`--dr-gutter: ${rem(t.layout.gutter.compact)}`], '  '),
    '}\n',
    // Written twice: the media block follows the system with JS off, the attribute lets a
    // stored choice win once the head script has run.
    '@media (prefers-color-scheme: dark) {\n',
    block(':root:not([data-theme="light"])', dark, '  '),
    '}\n',
    block(':root[data-theme="dark"]', dark),
    '@media (prefers-reduced-motion: reduce) {\n',
    block(':root', declarations(reducedEntries(t)), '  '),
    '}\n',
  ].join('');
}

// Surface, border and text drop their family in utility names, because the utility already
// says what it paints: bg-ground, text-ink, border-rule. Everything else keeps it.
function utilityColorName(cssName: string): string {
  return cssName.replace(/^--dr-(surface|border|text)-/, '').replace(/^--dr-/, '');
}

export function renderTailwindCss(t: Tokens = source): string {
  validate(t);
  const lines: string[] = [];
  for (const [name] of modeEntries(t, 'light')) {
    if (name.startsWith('--dr-shadow-')) continue;
    lines.push(`--color-${utilityColorName(name)}: var(${name})`);
  }
  for (const k of Object.keys(t.space)) lines.push(`--spacing-${k}: var(--dr-space-${k})`);
  // Sizes are heights and squares only, never padding or gaps: h-control-md, size-icon-sm.
  for (const [group, steps] of Object.entries(t.size)) {
    for (const k of Object.keys(steps)) {
      const name = `${group}-${kebab(k)}`;
      lines.push(
        `--height-${name}: var(--dr-size-${name})`,
        `--size-${name}: var(--dr-size-${name})`,
      );
    }
  }
  for (const k of Object.keys(t.radius)) lines.push(`--radius-${k}: var(--dr-radius-${k})`);
  lines.push('--font-sans: var(--dr-font-sans)', '--font-mono: var(--dr-font-mono)');
  for (const [step, s] of Object.entries(t.type)) {
    const name = `--text-${kebab(step)}`;
    lines.push(
      `${name}: ${rem(s.size)}`,
      `${name}--line-height: ${s.lineHeight}`,
      `${name}--letter-spacing: ${s.tracking}em`,
      `${name}--font-weight: ${s.weight}`,
    );
  }
  for (const k of Object.keys(t.weight)) lines.push(`--font-weight-${k}: var(--dr-weight-${k})`);
  for (const k of Object.keys(t.layer)) lines.push(`--z-index-${k}: var(--dr-layer-${k})`);
  for (const k of Object.keys(t.layout.docs)) {
    lines.push(`--container-docs-${k}: var(--dr-docs-${k})`);
  }
  lines.push('--height-shell-bar: var(--dr-shell-bar)');
  for (const k of ['nav', 'navCollapsed'] as const satisfies (keyof Tokens['layout']['shell'])[]) {
    lines.push(`--container-shell-${kebab(k)}: var(--dr-shell-${kebab(k)})`);
  }
  lines.push('--border-width-indicator: var(--dr-stroke-indicator)');
  for (const k of Object.keys(t.shadow)) lines.push(`--shadow-${k}: var(--dr-shadow-${k})`);
  for (const k of Object.keys(t.motion.ease)) {
    lines.push(`--ease-${kebab(k)}: var(--dr-ease-${kebab(k)})`);
  }
  for (const k of Object.keys(t.motion.duration)) {
    lines.push(`--transition-duration-${kebab(k)}: var(--dr-duration-${kebab(k)})`);
  }
  lines.push(
    `--breakpoint-sm: ${rem(t.layout.compactBelow)}`,
    '--container-page: var(--dr-page-max)',
    '--container-measure: var(--dr-measure)',
    '--default-font-family: var(--dr-font-sans)',
    '--default-mono-font-family: var(--dr-font-mono)',
    '--default-border-width: var(--dr-stroke-hairline)',
    '--default-outline-width: var(--dr-stroke-focus)',
    '--default-transition-duration: var(--dr-duration-base)',
    '--default-transition-timing-function: var(--dr-ease-enter)',
  );
  return [
    `/* ${HEADER} */\n`,
    '/* Import after Tailwind: @import "tailwindcss"; @import "@drefyn/ui/tailwind.css";\n',
    '   The reset removes every default palette, scale and breakpoint, so only token\n',
    '   utilities exist. Utilities read the --dr variables, so dark mode needs no variants. */\n',
    block('@theme', ['--*: initial']),
    block('@theme inline', lines),
    // The one way to draw focus, so no component types its own width or offset.
    block('@utility focus-ring', [
      'outline: var(--dr-stroke-focus) solid var(--dr-focus-ring)',
      'outline-offset: var(--dr-stroke-focus-offset)',
    ]),
    // Inside the item's own edge, for items flush in a container that would clip the ring.
    block('@utility focus-ring-inset', [
      'outline: var(--dr-stroke-focus) solid var(--dr-focus-ring)',
      'outline-offset: var(--dr-stroke-focus-inset)',
    ]),
    // Tailwind's transition list includes transform, so a plain transition would still
    // move things for the reduced fade time. Under reduced motion only colour and opacity
    // fade. Declared as the same utilities, so Tailwind sorts these into the utilities layer
    // with every variant applied, and motion-reduce:transition-none still comes after them.
    ...['transition', 'transition-all', 'transition-transform'].map(
      (name) =>
        `@utility ${name} {\n  @media (prefers-reduced-motion: reduce) {\n` +
        `    transition-property: ${REDUCED_TRANSITION.join(', ')};\n  }\n}\n`,
    ),
  ].join('');
}

// W3C design tokens format, for design tools. One way: tokens.ts stays the source.
export function renderDtcg(t: Tokens = source): string {
  validate(t);
  const color = (hex: Hex, alpha?: number) => {
    const components = channels(hex).map((c) => Math.round((c / 255) * 10_000) / 10_000);
    return {
      $type: 'color',
      $value: {
        colorSpace: 'srgb',
        components,
        ...(alpha === undefined ? {} : { alpha }),
        hex: hex.toLowerCase(),
      },
    };
  };
  const dimension = (value: number, unit: 'px' | 'rem') => ({
    $type: 'dimension',
    $value: { value, unit },
  });
  const modeGroup = (mode: Mode) => {
    const group: Record<string, unknown> = {};
    const walk = (node: unknown, target: Record<string, unknown>) => {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (isModeColor(child)) target[kebab(key)] = color(child[mode]);
        else walk(child, (target[kebab(key)] = {}));
      }
    };
    walk(t.color, group);
    (group['accent'] as Record<string, unknown>)['wash'] = color(
      t.wash[mode].base,
      t.wash[mode].alpha,
    );
    group['overlay'] = Object.fromEntries(
      Object.entries(t.overlay).map(([k, w]) => [kebab(k), color(w[mode].base, w[mode].alpha)]),
    );
    group['shadow'] = Object.fromEntries(
      Object.entries(t.shadow)
        .filter(([, layers]) => layers[mode].length > 0)
        .map(([level, layers]) => [
          level,
          {
            $type: 'shadow',
            $value: layers[mode].map((l) => ({
              color: color(t.color.text.ink.light, l.alpha).$value,
              offsetX: { value: 0, unit: 'px' },
              offsetY: { value: l.y, unit: 'px' },
              blur: { value: l.blur, unit: 'px' },
              spread: { value: 0, unit: 'px' },
            })),
          },
        ]),
    );
    return group;
  };
  const map = <V, R>(o: Record<string, V>, f: (v: V) => R) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [kebab(k), f(v)]));
  const doc = {
    $description: HEADER,
    light: modeGroup('light'),
    dark: modeGroup('dark'),
    font: map(t.font, (names) => ({ $type: 'fontFamily', $value: [...names] })),
    weight: map(t.weight, (w) => ({ $type: 'fontWeight', $value: w })),
    type: map(t.type, (s) => ({
      $type: 'typography',
      $value: {
        fontFamily: `{font.${s.family}}`,
        fontSize: { value: s.size / 16, unit: 'rem' },
        fontWeight: s.weight,
        // DTCG dimensions are px or rem only, so tracking is resolved against the size.
        letterSpacing: { value: Math.round(s.tracking * s.size * 1000) / 1000, unit: 'px' },
        lineHeight: s.lineHeight,
      },
    })),
    space: map(t.space, (v) => dimension(v / 16, 'rem')),
    size: map(t.size, (steps) => map(steps, (v) => dimension(v / 16, 'rem'))),
    radius: map(t.radius, (v) => dimension(v, 'px')),
    stroke: map(t.stroke, (v) => dimension(v, 'px')),
    duration: map(t.motion.duration, (d) => ({
      $type: 'duration',
      $value: { value: d.ms, unit: 'ms' },
    })),
    ease: map(t.motion.ease, (v) => ({ $type: 'cubicBezier', $value: [...v] })),
    timer: map(t.timer, (d) => ({ $type: 'duration', $value: { value: d.ms, unit: 'ms' } })),
    distance: map(t.motion.distance, (v) => dimension(v, 'px')),
    layout: {
      'page-max': dimension(t.layout.pageMax, 'px'),
      gutter: dimension(t.layout.gutter.wide / 16, 'rem'),
      'gutter-compact': dimension(t.layout.gutter.compact / 16, 'rem'),
      // DTCG dimensions are px or rem only, and the measure follows the text size.
      measure: {
        $type: 'number',
        $description: 'Reading measure in em, about 70 characters of Inter',
        $value: t.layout.measure,
      },
      ...Object.fromEntries(
        Object.entries(t.layout.docs).map(([k, v]) => [`docs-${k}`, dimension(v, 'px')]),
      ),
      ...Object.fromEntries(
        Object.entries(t.layout.shell).map(([k, v]) => [
          `shell-${kebab(k)}`,
          dimension(v / 16, 'rem'),
        ]),
      ),
    },
    layer: map(t.layer, (v) => ({ $type: 'number', $value: v })),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

// Canvas cannot read CSS variables, so the chart themes carry resolved values per mode.
function echartsTheme(t: Tokens, mode: Mode) {
  const c = t.color;
  const sans = family(t.font.sans);
  const mono = family(t.font.mono);
  const label = { color: c.text.secondary[mode], fontFamily: mono, fontSize: t.type.label.size };
  const axis = {
    axisLine: {
      show: true,
      lineStyle: { color: c.border.ruleStrong[mode], width: t.stroke.hairline },
    },
    axisTick: { show: false },
    axisLabel: label,
    splitLine: {
      show: true,
      lineStyle: { color: c.border.ruleStrong[mode], width: t.stroke.hairline },
    },
    splitArea: { show: false },
    nameTextStyle: label,
  };
  const emphasis = { focus: 'series', lineStyle: { color: c.accent.ink[mode] } };
  return {
    // One series in ink, a comparison in secondary. More than that gets direct labels or
    // small multiples, never a categorical rainbow, so the palette stops at two.
    color: [c.text.ink[mode], c.text.secondary[mode]],
    backgroundColor: 'transparent',
    // ECharts animates for a second by default. The theme is data, so the exact enter curve
    // and the reduced motion switch come from chartMotion; cubicOut is the nearest built in.
    animationDuration: t.motion.duration.moveSlow.ms,
    animationDurationUpdate: t.motion.duration.base.ms,
    animationEasing: 'cubicOut',
    animationEasingUpdate: 'cubicOut',
    textStyle: { color: c.text.body[mode], fontFamily: sans },
    title: {
      textStyle: { color: c.text.ink[mode], fontFamily: sans, fontWeight: t.weight.strong },
      subtextStyle: { color: c.text.secondary[mode], fontFamily: sans },
    },
    legend: { textStyle: { color: c.text.secondary[mode], fontFamily: sans } },
    tooltip: {
      backgroundColor: c.surface.overlay[mode],
      borderColor: c.border.ruleStrong[mode],
      borderWidth: t.stroke.hairline,
      textStyle: { color: c.text.body[mode], fontFamily: sans },
      extraCssText: `box-shadow: ${shadow(t.shadow[1][mode], t.color.text.ink.light)}; border-radius: ${px(t.radius.md)};`,
      axisPointer: { lineStyle: { color: c.border.control[mode] } },
    },
    categoryAxis: axis,
    valueAxis: axis,
    timeAxis: axis,
    logAxis: axis,
    line: {
      symbol: 'none',
      lineStyle: { width: t.stroke.icon },
      emphasis,
    },
    bar: {
      itemStyle: { borderRadius: t.radius.xs },
      emphasis: { focus: 'series', itemStyle: { color: c.accent.ink[mode] } },
    },
  };
}

export function renderEchartsTheme(t: Tokens = source): string {
  validate(t);
  const light = JSON.stringify(echartsTheme(t, 'light'), null, 2);
  const dark = JSON.stringify(echartsTheme(t, 'dark'), null, 2);
  return [
    `// ${HEADER}\n`,
    '// Register with echarts.registerTheme(name, theme) and switch with the page mode.\n\n',
    `const light = ${light} as const;\n\n`,
    `const dark = ${dark} as const;\n\n`,
    "export const echartsThemes = { 'drefyn-light': light, 'drefyn-dark': dark } as const;\n",
  ].join('');
}

export function generatedFiles(t: Tokens = source): Record<string, string> {
  return {
    'tokens.css': renderTokensCss(t),
    'tailwind.css': renderTailwindCss(t),
    'tokens.dtcg.json': renderDtcg(t),
    'echarts-theme.ts': renderEchartsTheme(t),
  };
}
