import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { echartsThemes } from '../src/generated/echarts-theme.ts';
import {
  generatedFiles,
  renderDtcg,
  renderEchartsTheme,
  renderTokensCss,
} from '../src/tokens/generate.ts';
import { tokens } from '../src/tokens/tokens.ts';
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
      /^--dr-(surface|border|text|disabled|accent|signal|state|focus|shadow)-/.test(n),
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
    expect(root.declarations.get('--dr-measure')).toBe('66ch');
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
    expect(light.line.emphasis.lineStyle.color).toBe(tokens.color.accent.ink.light);
  });

  it('animates with the motion tokens instead of the ECharts defaults', () => {
    for (const theme of [light, dark]) {
      expect(theme.animationDuration).toBe(tokens.motion.duration.moveSlow.ms);
      expect(theme.animationDurationUpdate).toBe(tokens.motion.duration.base.ms);
    }
  });
});
