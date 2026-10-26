import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'tailwindcss';
import { describe, expect, it } from 'vitest';
import { renderTailwindCss } from '../src/tokens/generate.ts';
import { tokens } from '../src/tokens/tokens.ts';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const tailwindDir = dirname(require.resolve('tailwindcss/package.json'));

// Compiles the way an app will: Tailwind first, then our theme on top.
async function build(candidates: string[]): Promise<string> {
  const input = '@import "tailwindcss";\n@import "./tailwind.css";\n';
  const compiler = await compile(input, {
    base: here,
    loadStylesheet: (id: string, base: string) => {
      if (id === './tailwind.css') {
        return Promise.resolve({ path: id, base, content: renderTailwindCss() });
      }
      const path = join(
        tailwindDir,
        id === 'tailwindcss' ? 'index.css' : id.replace(/^tailwindcss\//, ''),
      );
      return Promise.resolve({ path, base: dirname(path), content: readFileSync(path, 'utf8') });
    },
  });
  return compiler.build(candidates);
}

// The selector Tailwind writes for a class: every character outside a CSS identifier is
// backslash escaped, the backslash included.
const selector = (cls: string) => `.${cls.replace(/[^\w-]/g, '\\$&')}`;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasRule = (css: string, cls: string) =>
  new RegExp(`${escapeRegExp(selector(cls))}\\s*\\{`).test(css);

// The declarations of one class's rule, or undefined when Tailwind made no rule for it.
function ruleBody(css: string, cls: string): string | undefined {
  // A variant adds its pseudo class after the escaped name: .focus-visible\:x:focus-visible.
  const pattern = `${escapeRegExp(selector(cls))}(:[a-z-]+)*\\s*\\{([^}]*)\\}`;
  return new RegExp(pattern).exec(css)?.[2];
}

const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

describe('Tailwind theme', () => {
  it('is pinned to the version the reset was tested against', () => {
    const pkg = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    expect(pkg.devDependencies['tailwindcss']).toBe('4.3.3');
    expect(require('tailwindcss/package.json')).toMatchObject({ version: '4.3.3' });
  });

  it('generates utilities on the token scale and points them at the --dr variables', async () => {
    const css = await build([
      'p-16',
      'gap-4',
      'bg-ground',
      'text-ink',
      'border-rule',
      'bg-state-broken-mark',
      'rounded-md',
      'font-sans',
      'text-body-s',
      'font-strong',
      'shadow-1',
      'duration-base',
      'ease-enter',
      'max-w-page',
      'sm:p-8',
    ]);
    expect(css).toMatch(/\.p-16\s*\{\s*padding: var\(--dr-space-16\)/);
    expect(css).toMatch(/\.bg-ground\s*\{\s*background-color: var\(--dr-surface-ground\)/);
    expect(css).toMatch(/\.text-ink\s*\{\s*color: var\(--dr-text-ink\)/);
    expect(css).toMatch(/\.rounded-md\s*\{\s*border-radius: var\(--dr-radius-md\)/);
    expect(css).toMatch(/transition-duration: var\(--dr-duration-base\)/);
    expect(css).toMatch(/max-width: var\(--dr-page-max\)/);
    for (const cls of [
      'gap-4',
      'border-rule',
      'bg-state-broken-mark',
      'font-sans',
      'text-body-s',
      'font-strong',
      'shadow-1',
      'ease-enter',
      'sm:p-8',
    ]) {
      expect(hasRule(css, cls), cls).toBe(true);
    }
  });

  it('styles a disabled control with the disabled tokens, so it never needs opacity', async () => {
    const css = await build(['bg-disabled-fill', 'border-disabled-edge', 'text-disabled-text']);
    expect(css).toMatch(/\.bg-disabled-fill\s*\{\s*background-color: var\(--dr-disabled-fill\)/);
    expect(css).toMatch(/\.border-disabled-edge\s*\{\s*border-color: var\(--dr-disabled-edge\)/);
    expect(css).toMatch(/\.text-disabled-text\s*\{\s*color: var\(--dr-disabled-text\)/);
  });

  // Colours and type steps share the text-* namespace. A clash makes Tailwind pick one and
  // drop the other without a word, so every name is compiled and checked for what it sets.
  it('gives every type step a text-* utility that sets the size and nothing else', async () => {
    const classes = Object.keys(tokens.type).map((step) => `text-${kebab(step)}`);
    const css = await build(classes);
    for (const cls of classes) {
      const body = ruleBody(css, cls);
      expect(body, cls).toMatch(/font-size:/);
      expect(body, cls).not.toMatch(/(^|[^-])color:/);
    }
  });

  it('gives every colour role a text-* utility that sets the colour and nothing else', async () => {
    const names = [...renderTailwindCss().matchAll(/--color-([a-z0-9-]+):/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(20);
    const classes = names.map((n) => `text-${n ?? ''}`);
    const css = await build(classes);
    for (const cls of classes) {
      const body = ruleBody(css, cls);
      expect(body, cls).toMatch(/(^|[^-])color:/);
      expect(body, cls).not.toMatch(/font-size:/);
    }
  });

  it('ships one focus-ring utility that reads the focus tokens', async () => {
    const css = await build(['focus-visible:focus-ring']);
    const body = ruleBody(css, 'focus-visible:focus-ring');
    expect(body).toMatch(/outline: var\(--dr-stroke-focus\) solid var\(--dr-focus-ring\)/);
    expect(body).toMatch(/outline-offset: var\(--dr-stroke-focus-offset\)/);
  });

  it('ships an inset focus ring for items flush inside a container', async () => {
    const css = await build(['focus-visible:focus-ring-inset']);
    const body = ruleBody(css, 'focus-visible:focus-ring-inset');
    expect(body).toMatch(/outline: var\(--dr-stroke-focus\) solid var\(--dr-focus-ring\)/);
    expect(body).toMatch(/outline-offset: var\(--dr-stroke-focus-inset\)/);
  });

  it('sizes controls, icons and rows from the size tokens', async () => {
    const expected = {
      'h-control-sm': /height: var\(--dr-size-control-sm\)/,
      'h-control-md': /height: var\(--dr-size-control-md\)/,
      'min-h-control-lg': /min-height: var\(--dr-size-control-lg\)/,
      'size-control-sm':
        /width: var\(--dr-size-control-sm\);\s*height: var\(--dr-size-control-sm\)/,
      'size-icon-sm': /width: var\(--dr-size-icon-sm\);\s*height: var\(--dr-size-icon-sm\)/,
      'size-icon-lg': /width: var\(--dr-size-icon-lg\)/,
      'h-row-compact': /height: var\(--dr-size-row-compact\)/,
      'h-row-comfortable': /height: var\(--dr-size-row-comfortable\)/,
    };
    const css = await build(Object.keys(expected));
    for (const [cls, pattern] of Object.entries(expected)) {
      expect(ruleBody(css, cls), cls).toMatch(pattern);
    }
  });

  it('paints the fills, the overlay, the scrim and skeletons from their roles', async () => {
    const expected = {
      'bg-hover': '--dr-surface-hover',
      'bg-pressed': '--dr-surface-pressed',
      'bg-overlay': '--dr-surface-overlay',
      'bg-overlay-scrim': '--dr-overlay-scrim',
      'bg-skeleton-fill': '--dr-skeleton-fill',
    };
    const css = await build(Object.keys(expected));
    for (const [cls, variable] of Object.entries(expected)) {
      expect(ruleBody(css, cls), cls).toMatch(new RegExp(`background-color: var\\(${variable}\\)`));
    }
  });

  it('draws the selection indicator and lays out the shell from the tokens', async () => {
    const css = await build([
      'border-l-indicator',
      'border-b-indicator',
      'w-shell-nav',
      'w-shell-nav-collapsed',
      'h-shell-bar',
    ]);
    expect(ruleBody(css, 'border-l-indicator')).toMatch(
      /border-left-width: var\(--dr-stroke-indicator\)/,
    );
    expect(ruleBody(css, 'border-b-indicator')).toMatch(
      /border-bottom-width: var\(--dr-stroke-indicator\)/,
    );
    expect(ruleBody(css, 'w-shell-nav')).toMatch(/width: var\(--dr-shell-nav\)/);
    expect(ruleBody(css, 'w-shell-nav-collapsed')).toMatch(
      /width: var\(--dr-shell-nav-collapsed\)/,
    );
    expect(ruleBody(css, 'h-shell-bar')).toMatch(/height: var\(--dr-shell-bar\)/);
  });

  it('makes a shell utility for every shell key, so a new one cannot be left out', async () => {
    const theme = renderTailwindCss();
    for (const k of Object.keys(tokens.layout.shell)) {
      const name = `shell-${kebab(k)}`;
      expect(theme, k).toMatch(new RegExp(`--(height|container)-${name}: var\\(--dr-${name}\\)`));
    }
    const extra = {
      ...tokens,
      layout: { ...tokens.layout, shell: { ...tokens.layout.shell, inspector: 320 } },
    } as unknown as typeof tokens;
    expect(() => renderTailwindCss(extra)).toThrow(/shell\.inspector/);
  });

  it('makes no utility from a timer', async () => {
    const candidates = [
      'duration-toast',
      'duration-toast-undo',
      'delay-tooltip',
      'duration-reveal',
    ];
    const css = await build(candidates);
    for (const cls of candidates) expect(hasRule(css, cls), cls).toBe(false);
  });

  it('maps stacking and docs column utilities to the layout tokens', async () => {
    const css = await build(['z-base', 'z-raised', 'z-overlay', 'z-toast', 'w-docs-content']);
    for (const k of ['base', 'raised', 'overlay', 'toast']) {
      expect(ruleBody(css, `z-${k}`)).toMatch(new RegExp(`z-index: var\\(--dr-layer-${k}\\)`));
    }
    expect(ruleBody(css, 'w-docs-content')).toMatch(/width: var\(--dr-docs-content\)/);
  });

  // The stylesheet with every @layer block cut out.
  function outsideLayers(css: string): string {
    let out = '';
    let i = 0;
    for (let at = css.indexOf('@layer', i); at !== -1; at = css.indexOf('@layer', i)) {
      out += css.slice(i, at);
      const open = css.indexOf('{', at);
      const semicolon = css.indexOf(';', at);
      // A statement such as "@layer theme, base;" has no block.
      if (semicolon !== -1 && semicolon < open) {
        i = semicolon + 1;
        continue;
      }
      let depth = 0;
      let j = open;
      for (; j < css.length; j++) {
        if (css[j] === '{') depth += 1;
        if (css[j] === '}') depth -= 1;
        if (depth === 0) break;
      }
      i = j + 1;
    }
    return out + css.slice(i);
  }

  // The transition-property each rule in the utilities layer sets for one of these classes,
  // in cascade order. Under reduced motion every rule here applies, the motion-safe ones
  // aside, and they share a layer, so the last one wins.
  function reducedTransitionProperty(css: string, classes: string[]): string | undefined {
    const layer = css.slice(css.indexOf('@layer utilities'));
    const selectors = classes.map((c) => escapeRegExp(selector(c))).join('|');
    // Variants add pseudo classes after the name: .group-hover\:x:is(:where(.group):hover *).
    const rule = new RegExp(`(?:${selectors})(?![\\w\\\\-])[^{},]*\\{([^}]*)\\}`, 'g');
    let last: string | undefined;
    for (const match of layer.matchAll(rule)) {
      const value = /transition-property:([^;]*);/.exec(match[1] ?? '')?.[1];
      if (value !== undefined) last = value.trim();
    }
    return last;
  }

  it('keeps plain transition utilities from moving things under reduced motion', async () => {
    for (const cls of ['transition', 'transition-all', 'transition-transform']) {
      const css = await build([cls]);
      const props = reducedTransitionProperty(css, [cls]) ?? '';
      expect(props, cls).toMatch(/opacity/);
      for (const moving of ['transform', 'translate', 'scale', 'rotate', 'all']) {
        expect(props, `${cls} ${moving}`).not.toMatch(new RegExp(`\\b${moving}\\b`));
      }
    }
  });

  it('narrows a transition behind a variant too', async () => {
    // Kept in a fixture: the lint rule rejects these without motion-safe: in source.
    const classes = JSON.parse(
      readFileSync(join(here, 'fixtures/variant-transitions.json'), 'utf8'),
    ) as string[];
    expect(classes.length).toBeGreaterThan(0);
    const css = await build(classes);
    for (const cls of classes) {
      const props = reducedTransitionProperty(css, [cls]) ?? '';
      expect(props, cls).toMatch(/opacity/);
      expect(props, cls).not.toMatch(/\b(transform|all)\b/);
    }
  });

  it('lets motion-reduce:transition-none stop every transition under reduced motion', async () => {
    for (const cls of ['transition', 'transition-all', 'transition-transform']) {
      const css = await build([cls, 'motion-reduce:transition-none']);
      // An unlayered rule would beat the utilities layer whatever its order.
      expect(outsideLayers(css), cls).not.toMatch(/transition-property/);
      expect(reducedTransitionProperty(css, [cls, 'motion-reduce:transition-none']), cls).toBe(
        'none',
      );
    }
  });

  it('still compiles bare numbers and brackets, which is why the lint rule rejects them', async () => {
    // Kept in a fixture: the lint rule rightly rejects these anywhere in source.
    const escapes = JSON.parse(
      readFileSync(join(here, 'fixtures/tailwind-escapes.json'), 'utf8'),
    ) as string[];
    const css = await build(escapes);
    for (const cls of escapes) expect(css, cls).toContain(selector(cls));
  });

  it('generates nothing from the Tailwind defaults', async () => {
    const offScale = [
      'p-5',
      'm-20',
      'bg-red-500',
      'text-gray-700',
      'bg-white',
      'rounded-lg',
      'text-sm',
      'shadow-md',
      'font-bold',
      'tracking-tight',
      'leading-6',
      'max-w-prose',
      'ease-in-out',
      'md:p-8',
      'blur-sm',
      'h-10',
      'size-5',
      'p-40',
      'gap-40',
      // Sizes are heights and squares, never spacing or widths.
      'p-control-md',
      'gap-row-comfortable',
      'm-icon-sm',
      'w-control-md',
    ];
    const css = await build(offScale);
    for (const cls of offScale) expect(hasRule(css, cls), cls).toBe(false);
    // No default palette or scale variable survives the reset.
    expect(css).not.toMatch(/--color-(red|gray|white|black)/);
    expect(css).not.toMatch(/--spacing:/);
  });
});
