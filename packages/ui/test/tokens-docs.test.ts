import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  docsPropertyNames,
  renderDtcg,
  renderEchartsTheme,
  renderSurfaceTokensCss,
  renderTailwindCss,
  renderTokensCss,
} from '../src/tokens/generate.ts';
import { tokens, type Tokens } from '../src/tokens/tokens.ts';
import { findRule, parseRules, type Rule } from './css.ts';

const here = dirname(fileURLToPath(import.meta.url));
const spike = readFileSync(join(here, 'fixtures/docs-reader-v3.css'), 'utf8');

const DARK_MEDIA = '(prefers-color-scheme: dark)';
const DARK_SYSTEM = ':root:not([data-theme="light"])';
const DARK_CHOSEN = ':root[data-theme="dark"]';

// The spike wrote its palette over the shared names. The family moves every value under
// --dr-docs-, so the dashboard, website and status pages can never pick one up by accident.
const RENAMED: Record<string, string> = {
  '--dr-surface-ground': '--dr-docs-surface-ground',
  '--dr-surface-raised': '--dr-docs-surface-raised',
  '--dr-surface-sunken': '--dr-docs-surface-sunken',
  '--dr-surface-hover': '--dr-docs-surface-hover',
  '--dr-surface-overlay': '--dr-docs-surface-overlay',
  '--dr-card': '--dr-docs-surface-card',
  '--dr-name-bg': '--dr-docs-surface-chip',
  '--dr-border-rule': '--dr-docs-border-rule',
  '--dr-border-rule-strong': '--dr-docs-border-rule-strong',
  '--dr-border-control': '--dr-docs-border-control',
  '--dr-text-ink': '--dr-docs-text-ink',
  '--dr-text-body': '--dr-docs-text-body',
  '--dr-text-secondary': '--dr-docs-text-secondary',
  '--dr-text-subtle': '--dr-docs-text-subtle',
  '--dr-accent-ink': '--dr-docs-accent-ink',
  '--dr-accent-press': '--dr-docs-accent-press',
  '--dr-accent-on': '--dr-docs-accent-on',
  '--dr-accent-wash': '--dr-docs-wash-accent',
  '--dr-focus-ring': '--dr-docs-focus-ring',
  '--dr-overlay-scrim': '--dr-docs-overlay-scrim',
  '--dr-skeleton-fill': '--dr-docs-skeleton-fill',
  '--dr-state-fresh-text': '--dr-docs-state-fresh-text',
  '--dr-state-stale-text': '--dr-docs-state-stale-text',
  '--dr-state-broken-text': '--dr-docs-state-broken-text',
  '--dr-state-neutral-text': '--dr-docs-state-neutral-text',
  '--dr-shadow-1': '--dr-docs-shadow-1',
  '--dr-shadow-2': '--dr-docs-shadow-2',
  '--dr-docs-bar': '--dr-docs-layout-bar',
  '--dr-docs-side': '--dr-docs-layout-side',
  '--dr-docs-right': '--dr-docs-layout-right',
  '--dr-docs-toc': '--dr-docs-layout-toc',
  '--dr-docs-article': '--dr-docs-layout-article',
  '--dr-docs-modal': '--dr-docs-layout-modal',
  '--dr-docs-console': '--dr-docs-layout-console',
  '--dr-docs-console-h': '--dr-docs-layout-console-height',
  '--dr-docs-pop': '--dr-docs-layout-pop',
  '--dr-docs-r-card': '--dr-docs-radius-card',
  '--dr-docs-r-frame': '--dr-docs-radius-frame',
  '--dr-code-bg': '--dr-docs-code-bg',
  '--dr-code-text': '--dr-docs-code-text',
  '--dr-code-key': '--dr-docs-code-key',
  '--dr-code-str': '--dr-docs-code-str',
  '--dr-code-num': '--dr-docs-code-num',
  '--dr-code-kw': '--dr-docs-code-kw',
  '--dr-code-com': '--dr-docs-code-com',
  '--dr-code-flag': '--dr-docs-code-flag',
  '--dr-code-hit': '--dr-docs-wash-code-hit',
  '--dr-m-get': '--dr-docs-method-get',
  '--dr-m-get-bg': '--dr-docs-method-get-fill',
  '--dr-m-post': '--dr-docs-method-post',
  '--dr-m-post-bg': '--dr-docs-method-post-fill',
  '--dr-m-patch': '--dr-docs-method-patch',
  '--dr-m-patch-bg': '--dr-docs-method-patch-fill',
  '--dr-m-del': '--dr-docs-method-delete',
  '--dr-m-del-bg': '--dr-docs-method-delete-fill',
  '--dr-m-gql': '--dr-docs-method-graphql',
  '--dr-m-gql-bg': '--dr-docs-method-graphql-fill',
  '--dr-on-fill': '--dr-docs-method-on',
  '--dr-req': '--dr-docs-required-text',
  '--dr-req-bg': '--dr-docs-required-fill',
  '--dr-info-bg': '--dr-docs-wash-info',
  '--dr-stale-bg': '--dr-docs-wash-stale',
  '--dr-font-cjk': '--dr-docs-font-cjk',
  '--dr-font-arabic': '--dr-docs-font-arabic',
};

// A switch the spike's own script read, not a design value. color-scheme does the job here.
const NOT_TOKENS = new Set(['--dr-dark']);

function spikeValues(rule: Rule): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, value] of rule.declarations) {
    if (NOT_TOKENS.has(name)) continue;
    const renamed = RENAMED[name];
    if (renamed === undefined) throw new Error(`${name} in the spike has no docs token`);
    out.set(renamed, value);
  }
  return out;
}

const spikeRules = parseRules(spike);
const spikeLight = spikeValues(findRule(spikeRules, ':root'));
const spikeDarkSystem = spikeValues(findRule(spikeRules, DARK_SYSTEM, DARK_MEDIA));
const spikeDarkChosen = spikeValues(findRule(spikeRules, DARK_CHOSEN));

const docsCss = renderSurfaceTokensCss('docs');
const docsRules = parseRules(docsCss);
const docsRoot = findRule(docsRules, ':root');
const docsDarkSystem = findRule(docsRules, DARK_SYSTEM, DARK_MEDIA);
const docsDarkChosen = findRule(docsRules, DARK_CHOSEN);

const docsOnly = (decls: Map<string, string>) =>
  new Map([...decls].filter(([name]) => docsPropertyNames().includes(name)));

describe('docs token family', () => {
  it('emits the approved light values byte for byte', () => {
    expect(docsOnly(docsRoot.declarations)).toEqual(spikeLight);
  });

  it('emits the approved dark values byte for byte, for the system and a chosen theme', () => {
    // The spike repeats light only values in dark by inheritance, so dark is checked for every
    // value the spike changes there and the light block carries the rest.
    expect(spikeDarkSystem).toEqual(spikeDarkChosen);
    for (const [name, value] of spikeDarkSystem) {
      expect(docsDarkSystem.declarations.get(name), name).toBe(value);
      expect(docsDarkChosen.declarations.get(name), name).toBe(value);
    }
    expect(docsOnly(docsDarkSystem.declarations)).toEqual(spikeDarkSystem);
    expect(docsOnly(docsDarkChosen.declarations)).toEqual(spikeDarkChosen);
  });

  it('gives every colour a dark value', () => {
    const colours = [...spikeLight].filter(([, v]) => /^(#|rgb\()/.test(v)).map(([n]) => n);
    for (const name of colours) expect(docsDarkSystem.declarations.has(name), name).toBe(true);
  });

  it('names every property --dr-docs-{family}-{role}', () => {
    expect(docsPropertyNames().length).toBe(spikeLight.size);
    for (const name of docsPropertyNames()) {
      expect(name).toMatch(
        /^--dr-docs-(surface|border|text|accent|focus|overlay|skeleton|state|shadow|layout|radius|code|method|required|wash|font)(-[a-z0-9]+)+$/,
      );
    }
  });

  it('keeps the dashboard, website and status outputs free of the family', () => {
    const others = {
      'tokens.css': renderTokensCss(),
      'tailwind.css': renderTailwindCss(),
      'tokens.dtcg.json': renderDtcg(),
      'echarts-theme.ts': renderEchartsTheme(),
      status: renderSurfaceTokensCss('status'),
    };
    for (const [file, text] of Object.entries(others)) {
      for (const name of docsPropertyNames()) expect(text, `${file} ${name}`).not.toContain(name);
      expect(text, file).not.toContain('#5D5294');
    }
  });

  it('leaves the shared roles on docs pages as they were', () => {
    const root = findRule(parseRules(renderTokensCss()), ':root');
    for (const [name, value] of root.declarations) {
      if (name.startsWith('--dr-font-')) continue;
      expect(docsRoot.declarations.get(name), name).toBe(value);
    }
  });

  it('adds at most 2 KB gzipped to the docs CSS', () => {
    const without = renderSurfaceTokensCss('docs', { ...tokens, docs: emptyDocs() });
    expect(gzipSync(docsCss).length - gzipSync(without).length).toBeLessThanOrEqual(2 * 1024);
  });

  it('refuses a malformed docs colour', () => {
    const bad = structuredClone(tokens) as unknown as {
      docs: { color: { code: { key: { light: string } } } };
    };
    bad.docs.color.code.key.light = '#12';
    expect(() => renderSurfaceTokensCss('docs', bad as unknown as Tokens)).toThrow(/#12/);
  });

  it('states the docs only exception in the token source', () => {
    const source = readFileSync(join(here, '../src/tokens/tokens.ts'), 'utf8');
    expect(source).toMatch(/published docs sites only/i);
    expect(source).toMatch(/method badge always carries the method word/i);
    expect(source).toMatch(/state always carries its word and icon/i);
  });
});

function emptyDocs(): Tokens['docs'] {
  return {
    ...tokens.docs,
    color: {} as Tokens['docs']['color'],
    wash: {} as Tokens['docs']['wash'],
    overlay: {} as Tokens['docs']['overlay'],
    shadow: {} as Tokens['docs']['shadow'],
    font: {} as Tokens['docs']['font'],
    layout: {} as Tokens['docs']['layout'],
    radius: {} as Tokens['docs']['radius'],
  };
}
