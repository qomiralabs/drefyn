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
  const match = new RegExp(`${escapeRegExp(selector(cls))}\\s*\\{([^}]*)\\}`).exec(css);
  return match?.[1];
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
    ];
    const css = await build(offScale);
    for (const cls of offScale) expect(hasRule(css, cls), cls).toBe(false);
    // No default palette or scale variable survives the reset.
    expect(css).not.toMatch(/--color-(red|gray|white|black)/);
    expect(css).not.toMatch(/--spacing:/);
  });
});
