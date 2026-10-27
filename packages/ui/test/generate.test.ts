import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { echartsThemes } from '../src/generated/echarts-theme.ts';
import {
  generatedFiles,
  renderDtcg,
  renderEchartsTheme,
  renderTailwindCss,
  renderTokensCss,
} from '../src/tokens/generate.ts';
import { tokens, type Tokens } from '../src/tokens/tokens.ts';
import { findRule, parseRules } from './css.ts';

const here = dirname(fileURLToPath(import.meta.url));
const generatedDir = join(here, '../src/generated');

const DARK_MEDIA = '(prefers-color-scheme: dark)';
const DARK_SYSTEM = ':root:not([data-theme="light"])';
const DARK_CHOSEN = ':root[data-theme="dark"]';

describe('drift', () => {
  it('every committed generated file matches tokens.ts byte for byte', () => {
    // If this fails, run `pnpm --filter @drefyn/ui tokens` and commit the result.
    for (const [name, content] of Object.entries(generatedFiles())) {
      expect(readFileSync(join(generatedDir, name), 'utf8'), name).toBe(content);
    }
  });

  it('the generated folder holds nothing the generator does not write', () => {
    expect(readdirSync(generatedDir).sort()).toEqual(Object.keys(generatedFiles()).sort());
  });

  it('the shipped ECharts themes are the ones rendered from the tokens', () => {
    expect(renderEchartsTheme()).toContain(JSON.stringify(echartsThemes['drefyn-dark'], null, 2));
  });
});

describe('tokens.css', () => {
  const css = renderTokensCss();
  const rules = parseRules(css);
  const root = findRule(rules, ':root');

  it('names every custom property --dr-{family}-{role}[-{variant}]', () => {
    const names = [...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(80);
    for (const name of names) expect(name).toMatch(/^--dr-[a-z]+(-[a-z0-9]+)*$/);
  });

  it('puts the light roles on :root', () => {
    expect(root.declarations.get('color-scheme')).toBe('light');
    expect(root.declarations.get('--dr-surface-ground')).toBe('#FAFAF9');
    expect(root.declarations.get('--dr-text-ink')).toBe('#0B1120');
    expect(root.declarations.get('--dr-state-broken-text')).toBe('#B91C1C');
    expect(root.declarations.get('--dr-accent-wash')).toBe('rgb(79 70 229 / 0.08)');
  });

  it('follows the system in dark unless light is chosen, and always when dark is chosen', () => {
    const system = findRule(rules, DARK_SYSTEM, DARK_MEDIA);
    const chosen = findRule(rules, DARK_CHOSEN);
    expect(system.declarations.get('color-scheme')).toBe('dark');
    expect(system.declarations.get('--dr-surface-ground')).toBe('#141210');
    expect(system.declarations.get('--dr-accent-on')).toBe('#141210');
    expect(system.declarations.get('--dr-shadow-1')).toBe('none');
    expect([...chosen.declarations]).toEqual([...system.declarations]);
  });

  it('draws disabled controls from their own opaque colours in both modes', () => {
    const system = findRule(rules, DARK_SYSTEM, DARK_MEDIA);
    const names = ['--dr-disabled-fill', '--dr-disabled-edge', '--dr-disabled-text'];
    expect(names.map((n) => root.declarations.get(n))).toEqual(['#F5F5F4', '#D6D3D1', '#94A3B8']);
    expect(names.map((n) => system.declarations.get(n))).toEqual(['#1C1A17', '#44403C', '#57534E']);
    expect(root.declarations.has('--dr-text-disabled')).toBe(false);
  });

  it('redefines every colour role in dark and nothing that does not change', () => {
    const system = findRule(rules, DARK_SYSTEM, DARK_MEDIA);
    const colorNames = [...root.declarations.keys()].filter((n) =>
      /^--dr-(surface|border|text|disabled|accent|signal|state|focus|skeleton|overlay|shadow)-/.test(
        n,
      ),
    );
    const darkNames = [...system.declarations.keys()].filter((n) => n !== 'color-scheme');
    expect(darkNames.sort()).toEqual(colorNames.sort());
  });

  it('has retired the navy dark ground', () => {
    for (const rule of rules) {
      for (const [name, value] of rule.declarations) {
        if (name.startsWith('--dr-surface-')) expect(value).not.toBe('#0B1120');
      }
    }
  });

  it('ships the spike additions', () => {
    expect(root.declarations.get('--dr-distance-enter')).toBe('4px');
    expect(root.declarations.get('--dr-stroke-gutter')).toBe('4px');
    expect(root.declarations.get('--dr-page-max')).toBe('1200px');
    expect(root.declarations.get('--dr-gutter')).toBe('1.5rem');
    // Strictly below, so at exactly 40rem the wide gutter and Tailwind's sm apply together.
    expect(findRule(rules, ':root', '(width < 40rem)').declarations.get('--dr-gutter')).toBe(
      '1rem',
    );
    expect(css).not.toContain('max-width: 40rem');
  });

  it('ships the focus offset, the stacking layers and the docs columns', () => {
    expect(root.declarations.get('--dr-stroke-focus')).toBe('2px');
    expect(root.declarations.get('--dr-stroke-focus-offset')).toBe('2px');
    const layers = ['base', 'raised', 'overlay', 'toast'].map((k) =>
      Number(root.declarations.get(`--dr-layer-${k}`)),
    );
    expect(layers).toEqual([...layers].sort((a, b) => a - b));
    expect(new Set(layers).size).toBe(4);
    expect(root.declarations.get('--dr-docs-nav')).toBe('240px');
    expect(root.declarations.get('--dr-docs-content')).toBe('640px');
    expect(root.declarations.get('--dr-docs-toc')).toBe('220px');
  });

  it('ships the hover and pressed fills, the overlay surface and the scrim in both modes', () => {
    const system = findRule(rules, DARK_SYSTEM, DARK_MEDIA);
    const names = [
      '--dr-surface-hover',
      '--dr-surface-pressed',
      '--dr-overlay-scrim',
      '--dr-skeleton-fill',
    ];
    expect(names.map((n) => root.declarations.get(n))).toEqual([
      '#F1F0EE',
      '#EBE9E7',
      'rgb(11 17 32 / 0.24)',
      root.declarations.get('--dr-border-rule'),
    ]);
    expect(names.map((n) => system.declarations.get(n))).toEqual([
      '#262320',
      '#2E2A26',
      'rgb(0 0 0 / 0.5)',
      system.declarations.get('--dr-border-rule'),
    ]);
  });

  it('resolves the overlay surface to ground in light and raised in dark', () => {
    const system = findRule(rules, DARK_SYSTEM, DARK_MEDIA);
    const chosen = findRule(rules, DARK_CHOSEN);
    expect(root.declarations.get('--dr-surface-overlay')).toBe(
      root.declarations.get('--dr-surface-ground'),
    );
    expect(root.declarations.get('--dr-surface-overlay')).toBe('#FAFAF9');
    for (const dark of [system, chosen]) {
      expect(dark.declarations.get('--dr-surface-overlay')).toBe(
        dark.declarations.get('--dr-surface-raised'),
      );
      expect(dark.declarations.get('--dr-surface-overlay')).toBe('#1C1A17');
    }
  });

  it('ships control, icon and row sizes, the new strokes and the shell widths', () => {
    const expected = {
      '--dr-size-control-sm': '1.5rem',
      '--dr-size-control-md': '2rem',
      '--dr-size-control-lg': '2.5rem',
      '--dr-size-icon-sm': '1rem',
      '--dr-size-icon-md': '1.25rem',
      '--dr-size-icon-lg': '1.5rem',
      '--dr-size-row-compact': '2rem',
      '--dr-size-row-comfortable': '2.5rem',
      '--dr-stroke-focus-inset': '-2px',
      '--dr-stroke-indicator': '2px',
      '--dr-shell-bar': '3rem',
      '--dr-shell-nav': '15rem',
      '--dr-shell-nav-collapsed': '3rem',
    };
    for (const [name, value] of Object.entries(expected)) {
      expect(root.declarations.get(name), name).toBe(value);
    }
  });

  it('reads the bottom safe area from the device, falling back to nothing', () => {
    expect(root.declarations.get('--dr-safe-bottom')).toBe('env(safe-area-inset-bottom, 0px)');
  });

  it('keeps 40 out of the space scale; it lives in the size family only', () => {
    expect(Object.keys(tokens.space)).not.toContain('40');
    expect(root.declarations.has('--dr-space-40')).toBe(false);
    expect(tokens.size.control.lg).toBe(40);
    expect(tokens.size.row.comfortable).toBe(40);
  });

  it('ships the waits as timers, not as durations', () => {
    expect(root.declarations.get('--dr-timer-tooltip')).toBe('500ms');
    expect(root.declarations.get('--dr-timer-reveal')).toBe('200ms');
    expect(root.declarations.get('--dr-timer-toast')).toBe('6000ms');
    expect(root.declarations.get('--dr-timer-toast-undo')).toBe('10000ms');
    expect([...root.declarations.keys()].filter((n) => n.startsWith('--dr-duration-'))).toEqual(
      Object.keys(tokens.motion.duration).map(
        (k) => `--dr-duration-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`,
      ),
    );
  });

  it('sets tabular figures on number elements without adding specificity', () => {
    const base = findRule(rules, ':where(time, data, output, td, th, [data-numeric])');
    expect(base.declarations.get('font-variant-numeric')).toBe('tabular-nums');
  });

  it('ships every family the source declares', () => {
    expect(root.declarations.get('--dr-space-16')).toBe('1rem');
    expect(root.declarations.get('--dr-space-128')).toBe('8rem');
    expect(root.declarations.get('--dr-radius-md')).toBe('6px');
    expect(root.declarations.get('--dr-stroke-icon')).toBe('1.5px');
    expect(root.declarations.get('--dr-type-display-xl')).toBe(
      '600 4.5rem/1.05 var(--dr-font-sans)',
    );
    expect(root.declarations.get('--dr-type-display-xl-tracking')).toBe('-0.03em');
    expect(root.declarations.get('--dr-type-label')).toBe('500 0.75rem/1.2 var(--dr-font-mono)');
    expect(root.declarations.get('--dr-type-body-m-tracking')).toBe('0em');
    expect(root.declarations.get('--dr-weight-strong')).toBe('600');
    expect(root.declarations.get('--dr-measure')).toBe('35em');
    expect(root.declarations.get('--dr-duration-move-base')).toBe('180ms');
    expect(root.declarations.get('--dr-ease-enter')).toBe('cubic-bezier(0.2, 0, 0, 1)');
    expect(root.declarations.get('--dr-shadow-2')).toBe('0 16px 48px rgb(11 17 32 / 0.16)');
    expect(root.declarations.get('--dr-font-sans')).toBe(
      '"Inter", "Inter fallback", ui-sans-serif, system-ui, sans-serif',
    );
    for (const step of Object.keys(tokens.type)) {
      const name = step.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      expect(root.declarations.has(`--dr-type-${name}`), step).toBe(true);
      expect(root.declarations.has(`--dr-type-${name}-tracking`), step).toBe(true);
    }
  });

  it('declares the self hosted faces and the metric matched fallback', () => {
    const faces = rules.filter((r) => r.selector === '@font-face');
    expect(faces.map((f) => f.declarations.get('font-family'))).toEqual([
      '"Inter"',
      '"Inter"',
      '"Inter"',
      '"JetBrains Mono"',
      '"JetBrains Mono"',
      '"Inter fallback"',
    ]);
    for (const face of faces.slice(0, 5)) {
      expect(face.declarations.get('font-display')).toBe('swap');
      expect(face.declarations.get('src')).toMatch(/^url\("\.\.\/fonts\/[a-z0-9-]+\.woff2"\)/);
    }
    const fallback = faces[5];
    expect(fallback?.declarations.get('src')).toBe('local("Arial")');
    expect(fallback?.declarations.get('size-adjust')).toBe('107.4%');
  });
});

describe('tokens.dtcg.json', () => {
  const dtcg = JSON.parse(renderDtcg()) as Record<string, unknown>;

  function leaves(
    node: unknown,
    path: string[] = [],
  ): { path: string; token: Record<string, unknown> }[] {
    if (typeof node !== 'object' || node === null) return [];
    const record = node as Record<string, unknown>;
    if ('$value' in record) return [{ path: path.join('.'), token: record }];
    return Object.entries(record)
      .filter(([k]) => !k.startsWith('$'))
      .flatMap(([k, v]) => leaves(v, [...path, k]));
  }

  it('gives every token a known DTCG type', () => {
    const all = leaves(dtcg);
    expect(all.length).toBeGreaterThan(80);
    const types = new Set([
      'color',
      'dimension',
      'duration',
      'cubicBezier',
      'fontFamily',
      'fontWeight',
      'number',
      'shadow',
      'typography',
    ]);
    for (const { path, token } of all) expect(types.has(token['$type'] as string), path).toBe(true);
  });

  it('writes colours as sRGB with their hex, light and dark side by side', () => {
    const byPath = new Map(leaves(dtcg).map((l) => [l.path, l.token]));
    expect(byPath.get('light.surface.ground')?.['$value']).toEqual({
      colorSpace: 'srgb',
      components: [0.9804, 0.9804, 0.9765],
      hex: '#fafaf9',
    });
    expect((byPath.get('dark.surface.ground')?.['$value'] as { hex: string }).hex).toBe('#141210');
    expect(byPath.get('space.16')?.['$value']).toEqual({ value: 1, unit: 'rem' });
    expect(byPath.get('duration.move-base')?.['$value']).toEqual({ value: 180, unit: 'ms' });
    expect(byPath.get('layout.docs-content')?.['$value']).toEqual({ value: 640, unit: 'px' });
    expect(byPath.get('layer.overlay')?.['$type']).toBe('number');
    // The safe area is the device's, not a design value, so design tools get nothing to set.
    expect([...byPath.keys()].filter((path) => path.includes('safe'))).toEqual([]);
  });

  it('carries the component tokens with their types', () => {
    const byPath = new Map(leaves(dtcg).map((l) => [l.path, l.token]));
    const hex = (path: string) => (byPath.get(path)?.['$value'] as { hex: string }).hex;
    expect(hex('light.surface.hover')).toBe('#f1f0ee');
    expect(hex('dark.surface.pressed')).toBe('#2e2a26');
    expect(hex('light.surface.overlay')).toBe('#fafaf9');
    expect(hex('dark.surface.overlay')).toBe('#1c1a17');
    expect(hex('dark.skeleton.fill')).toBe('#292524');
    expect(byPath.get('light.overlay.scrim')).toEqual({
      $type: 'color',
      $value: {
        colorSpace: 'srgb',
        components: [0.0431, 0.0667, 0.1255],
        alpha: 0.24,
        hex: '#0b1120',
      },
    });
    expect(byPath.get('dark.overlay.scrim')?.['$value']).toMatchObject({ alpha: 0.5 });
    expect(byPath.get('size.control.md')).toEqual({
      $type: 'dimension',
      $value: { value: 2, unit: 'rem' },
    });
    expect(byPath.get('size.icon.sm')?.['$value']).toEqual({ value: 1, unit: 'rem' });
    expect(byPath.get('size.row.comfortable')?.['$value']).toEqual({ value: 2.5, unit: 'rem' });
    expect(byPath.get('stroke.focus-inset')?.['$value']).toEqual({ value: -2, unit: 'px' });
    expect(byPath.get('stroke.indicator')?.['$value']).toEqual({ value: 2, unit: 'px' });
    expect(byPath.get('layout.shell-nav')).toEqual({
      $type: 'dimension',
      $value: { value: 15, unit: 'rem' },
    });
    expect(byPath.get('layout.shell-nav-collapsed')?.['$value']).toEqual({
      value: 3,
      unit: 'rem',
    });
    expect(byPath.get('timer.toast-undo')).toEqual({
      $type: 'duration',
      $value: { value: 10000, unit: 'ms' },
    });
    expect(byPath.get('timer.tooltip')?.['$value']).toEqual({ value: 500, unit: 'ms' });
  });
});

// Timers are waits, not transitions. As a Tailwind duration utility a toast timer would be a
// six second transition, and the reduced motion cap would close toasts after 120 ms.
describe('timers', () => {
  it('stay out of the Tailwind theme', () => {
    const tailwind = renderTailwindCss();
    expect(tailwind).not.toMatch(/timer/);
    expect(tailwind).not.toMatch(/toast-undo|--transition-duration-(tooltip|reveal|toast)/);
  });

  it('are not durations, so the reduced motion rules never see them', () => {
    for (const key of ['tooltip', 'reveal', 'toast', 'toastUndo']) {
      expect(Object.keys(tokens.motion.duration), key).not.toContain(key);
    }
    expect(Object.keys(tokens.timer)).toEqual(['tooltip', 'reveal', 'toast', 'toastUndo']);
  });
});

describe('ECharts themes', () => {
  const light = echartsThemes['drefyn-light'];
  const dark = echartsThemes['drefyn-dark'];

  it('draws a single series in ink and a comparison in secondary, never a rainbow', () => {
    expect(light.color).toEqual([tokens.color.text.ink.light, tokens.color.text.secondary.light]);
    expect(dark.color).toEqual([tokens.color.text.ink.dark, tokens.color.text.secondary.dark]);
  });

  it('keeps state colours out of the series palette', () => {
    // Neutral is grey on purpose, the same as secondary, so only the three hues count.
    const { fresh, stale, broken } = tokens.color.state;
    const states = [fresh, stale, broken].flatMap((s) => [
      s.mark.light,
      s.mark.dark,
      s.text.light,
      s.text.dark,
    ]);
    for (const c of [...light.color, ...dark.color]) expect(states).not.toContain(c);
  });

  it('uses the token roles for axes, labels and tooltips', () => {
    expect(light.backgroundColor).toBe('transparent');
    expect(light.categoryAxis.splitLine.lineStyle.color).toBe(tokens.color.border.ruleStrong.light);
    expect(dark.valueAxis.axisLabel.color).toBe(tokens.color.text.secondary.dark);
    expect(dark.tooltip.backgroundColor).toBe(tokens.color.surface.raised.dark);
    // Tooltips float, so they sit where menus do: paper with a shadow in light, raised in dark.
    expect(light.tooltip.backgroundColor).toBe(tokens.color.surface.overlay.light);
    expect(light.tooltip.backgroundColor).toBe(tokens.color.surface.ground.light);
    expect(dark.tooltip.backgroundColor).toBe(tokens.color.surface.overlay.dark);
    expect(light.line.emphasis.lineStyle.color).toBe(tokens.color.accent.ink.light);
  });

  it('animates with the motion tokens instead of the ECharts defaults', () => {
    for (const theme of [light, dark]) {
      expect(theme.animationDuration).toBe(tokens.motion.duration.moveSlow.ms);
      expect(theme.animationDurationUpdate).toBe(tokens.motion.duration.base.ms);
    }
  });
});

// The generator writes colours straight into CSS and splits them into channels, so anything
// that is not #RRGGBB must stop the build rather than ship a wrong or broken value.
describe('colour values', () => {
  const withInk = (light: string): Tokens =>
    ({
      ...tokens,
      color: {
        ...tokens.color,
        text: { ...tokens.color.text, ink: { ...tokens.color.text.ink, light } },
      },
    }) as unknown as Tokens;
  const withWash = (base: string): Tokens =>
    ({
      ...tokens,
      wash: { ...tokens.wash, dark: { ...tokens.wash.dark, base } },
    }) as unknown as Tokens;

  it.each(['#fff', '#FFFFFFFF', 'red', '#00000G', '#000; } body { color: red'])(
    'rejects %s in a colour role',
    (value) => {
      expect(() => renderTokensCss(withInk(value))).toThrow(/#RRGGBB/);
      expect(() => renderDtcg(withInk(value))).toThrow(/#RRGGBB/);
    },
  );

  it('rejects a three digit wash base', () => {
    expect(() => renderTokensCss(withWash('#fff'))).toThrow(/#RRGGBB/);
    expect(() => renderDtcg(withWash('#fff'))).toThrow(/#RRGGBB/);
  });

  it('accepts lower case six digit hex', () => {
    expect(renderTokensCss(withInk('#0b1120'))).toContain('--dr-text-ink: #0b1120;');
  });
});

// Numbers and names go straight into CSS, JSON and the chart themes. A NaN, an Infinity, a
// negative size or a name with a space would ship a broken or silently wrong value.
describe('numbers and names', () => {
  const renderers = { renderTokensCss, renderTailwindCss, renderDtcg, renderEchartsTheme };
  const withSpace = (key: string, v: number): Tokens => ({
    ...tokens,
    space: { ...tokens.space, [key]: v },
  });
  const withBorder = (key: string): Tokens => ({
    ...tokens,
    color: {
      ...tokens.color,
      border: { ...tokens.color.border, [key]: tokens.color.border.rule },
    },
  });
  const withDuration = (ms: number): Tokens =>
    ({
      ...tokens,
      motion: {
        ...tokens.motion,
        duration: { ...tokens.motion.duration, base: { ms, kind: 'fade' } },
      },
    }) as unknown as Tokens;
  const withAlpha = (alpha: number): Tokens =>
    ({
      ...tokens,
      wash: { ...tokens.wash, light: { ...tokens.wash.light, alpha } },
    }) as unknown as Tokens;

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -4])(
    'rejects %s as a size, a duration and an alpha in every format',
    (value) => {
      for (const [name, render] of Object.entries(renderers)) {
        expect(() => render(withSpace('16', value)), name).toThrow(/space\.16/);
        expect(() => render(withDuration(value)), name).toThrow(/motion\.duration\.base\.ms/);
        expect(() => render(withAlpha(value)), name).toThrow(/wash\.light\.alpha/);
      }
    },
  );

  it.each(['rule strong', 'rule_strong', 'Rule', 'rule;', '', 'rulé'])(
    'rejects the role name "%s" in every format',
    (key) => {
      for (const [name, render] of Object.entries(renderers)) {
        expect(() => render(withBorder(key)), name).toThrow(/name/);
      }
    },
  );

  it('rejects a bad name outside the colours too', () => {
    expect(() => renderTokensCss(withSpace('1 6', 16))).toThrow(/name/);
  });

  it('still allows negative tracking, which tightens display type', () => {
    expect(tokens.type.displayXl.tracking).toBeLessThan(0);
    expect(() => generatedFiles()).not.toThrow();
  });

  it('allows the inset focus offset below zero, and no other stroke', () => {
    const withStroke = (key: string, v: number): Tokens => ({
      ...tokens,
      stroke: { ...tokens.stroke, [key]: v },
    });
    expect(tokens.stroke.focusInset).toBe(-2);
    expect(() => renderTokensCss()).not.toThrow();
    for (const [name, render] of Object.entries(renderers)) {
      expect(() => render(withStroke('focusInset', -2)), name).not.toThrow();
      expect(() => render(withStroke('focusOffset', -2)), name).toThrow(/stroke\.focusOffset/);
      expect(() => render(withStroke('indicator', -2)), name).toThrow(/stroke\.indicator/);
      expect(() => render(withStroke('focusInset', Number.NaN)), name).toThrow(
        /stroke\.focusInset/,
      );
    }
  });

  it('keeps the inset focus offset at or below zero, so it can never push the ring out', () => {
    const withInset = (v: number): Tokens =>
      ({ ...tokens, stroke: { ...tokens.stroke, focusInset: v } }) as unknown as Tokens;
    for (const [name, render] of Object.entries(renderers)) {
      expect(() => render(withInset(0)), name).not.toThrow();
      expect(() => render(withInset(2)), name).toThrow(/stroke\.focusInset.*above zero/);
    }
  });

  it('refuses an alpha that is not a number or lies outside 0 to 1', () => {
    const withScrim = (alpha: unknown): Tokens =>
      ({
        ...tokens,
        overlay: { scrim: { ...tokens.overlay.scrim, dark: { base: '#000000', alpha } } },
      }) as unknown as Tokens;
    for (const [name, render] of Object.entries(renderers)) {
      expect(() => render(withScrim('0.5')), name).toThrow(/overlay\.scrim\.dark\.alpha/);
      expect(() => render(withScrim(undefined)), name).toThrow(/overlay\.scrim\.dark\.alpha/);
      expect(() => render(withScrim(1.5)), name).toThrow(/overlay\.scrim\.dark\.alpha.*above 1/);
      expect(() => render(withScrim(1)), name).not.toThrow();
    }
    expect(() => renderTokensCss(withAlpha(2))).toThrow(/wash\.light\.alpha/);
  });

  it('refuses a timer whose ms is not a number', () => {
    const withTimer = (ms: unknown): Tokens =>
      ({ ...tokens, timer: { ...tokens.timer, toast: { ms } } }) as unknown as Tokens;
    for (const [name, render] of Object.entries(renderers)) {
      expect(() => render(withTimer('6000')), name).toThrow(/timer\.toast\.ms/);
      expect(() => render(withTimer(null)), name).toThrow(/timer\.toast\.ms/);
    }
  });

  it('accepts camelCase role names, which become kebab case', () => {
    expect(renderTokensCss(withBorder('ruleFaint'))).toContain('--dr-border-rule-faint:');
  });
});
