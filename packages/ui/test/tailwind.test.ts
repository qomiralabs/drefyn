import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'tailwindcss';
import { describe, expect, it } from 'vitest';
import { renderTailwindCss } from '../src/tokens/generate.ts';

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

const hasRule = (css: string, cls: string) =>
  new RegExp(`\\.${cls.replace(/[:]/g, '\\\\:')}\\s*\\{`).test(css);

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

  it('still compiles bare numbers and brackets, which is why the lint rule rejects them', async () => {
    // Kept in a fixture: the lint rule rightly rejects these anywhere in source.
    const escapes = JSON.parse(
      readFileSync(join(here, 'fixtures/tailwind-escapes.json'), 'utf8'),
    ) as string[];
    const css = await build(escapes);
    for (const cls of escapes) expect(css, cls).toContain(`.${cls.replace(/[[\]/]/g, '\\$&')}`);
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
