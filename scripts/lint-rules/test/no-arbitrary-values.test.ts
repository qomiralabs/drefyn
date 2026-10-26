import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint, RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import plugin, { noArbitraryValues } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../../..');

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const arbitrary = (token: string) => ({ messageId: 'arbitrary' as const, data: { token } });

tester.run('no-arbitrary-values', noArbitraryValues, {
  valid: [
    `const c = 'p-16 bg-ground text-ink rounded-md shadow-1';`,
    `const c = 'sm:p-8 hover:bg-raised focus-visible:outline';`,
    `const c = 'data-[state=open]:bg-raised group-aria-[selected=true]:text-ink';`,
    `const c = 'w-1/2 aspect-16/9 grid-cols-3 duration-base ease-enter';`,
    // Zero is not a size, and full or no opacity is the measured colour or nothing.
    `const c = 'border-0 outline-0 opacity-0 opacity-100 delay-0 duration-0';`,
    `const c = 'border border-rule outline outline-focus-ring ring-accent-ink';`,
    // Full colour is the measured colour, and the identity filters change nothing.
    `const c = 'bg-ink/100 text-ink/100 brightness-100 contrast-100 saturate-100 grayscale-0';`,
    `const c = 'z-auto z-base z-overlay focus-visible:focus-ring stroke-0 decoration-0';`,
    // Component sizes, fills and strokes are named tokens.
    `const c = 'h-control-md size-icon-sm min-h-row-compact w-shell-nav h-shell-bar';`,
    `const c = 'bg-hover active:bg-pressed bg-overlay bg-overlay-scrim bg-skeleton-fill';`,
    `const c = 'focus-visible:focus-ring-inset border-l-indicator border-accent-ink';`,
    `const c = 'decoration-rule underline-offset-auto stroke-ink';`,
    // Plain prose and data are not class lists.
    `const s = 'Look at [this] and a-b';`,
    `const list = [1, 2, 3];`,
    `import x from './[slug].ts';`,
  ],
  invalid: [
    { code: `const c = 'p-[13px]';`, errors: [arbitrary('p-[13px]')] },
    { code: `const c = 'text-[#ff0000]';`, errors: [arbitrary('text-[#ff0000]')] },
    { code: `const c = 'bg-[rgb(0,0,0)]';`, errors: [arbitrary('bg-[rgb(0,0,0)]')] },
    { code: `const c = 'hover:!mt-[2rem]';`, errors: [arbitrary('hover:!mt-[2rem]')] },
    { code: `const c = '-mt-[2px]';`, errors: [arbitrary('-mt-[2px]')] },
    // A size the tokens do not have, even one that matches a token value.
    { code: `const c = 'h-[40px]';`, errors: [arbitrary('h-[40px]')] },
    { code: `const c = 'size-[1.25rem]';`, errors: [arbitrary('size-[1.25rem]')] },
    { code: `const c = 'w-(--dr-shell-nav)';`, errors: [arbitrary('w-(--dr-shell-nav)')] },
    { code: `const c = '[mask-type:luminance]';`, errors: [arbitrary('[mask-type:luminance]')] },
    { code: `const c = 'bg-ink/[0.3]';`, errors: [arbitrary('bg-ink/[0.3]')] },
    { code: `const c = 'bg-ink/(--alpha)';`, errors: [arbitrary('bg-ink/(--alpha)')] },
    { code: `const c = 'p-(--my-space)';`, errors: [arbitrary('p-(--my-space)')] },
    { code: `const c = 'min-[700px]:p-16';`, errors: [arbitrary('min-[700px]:p-16')] },
    { code: `const c = \`p-16 \${x} gap-[3px]\`;`, errors: [arbitrary('gap-[3px]')] },
    { code: `const el = <div className="flex p-[13px]" />;`, errors: [arbitrary('p-[13px]')] },
    {
      code: `const c = 'text-ink/50';`,
      errors: [{ messageId: 'opacity', data: { token: 'text-ink/50' } }],
    },
    ...[
      'border-2',
      'border-x-2',
      'border-t-4',
      'divide-y-2',
      'outline-2',
      'ring-1',
      'decoration-2',
      'decoration-1.5',
      'underline-offset-4',
      'stroke-2',
      'stroke-1.5',
    ].map((token) => ({
      code: `const c = '${token}';`,
      errors: [{ messageId: 'stroke' as const, data: { token } }],
    })),
    ...['outline-offset-2', 'focus-visible:outline-offset-4', 'ring-offset-2'].map((token) => ({
      code: `const c = '${token}';`,
      errors: [{ messageId: 'offset' as const, data: { token } }],
    })),
    ...[
      'brightness-50',
      'contrast-125',
      'saturate-50',
      'backdrop-brightness-75',
      'hue-rotate-15',
      'grayscale-50',
      'grayscale',
      'invert',
      'sepia-30',
    ].map((token) => ({
      code: `const c = '${token}';`,
      errors: [{ messageId: 'filter' as const, data: { token } }],
    })),
    ...['z-10', 'z-0', '-z-10', 'hover:z-50'].map((token) => ({
      code: `const c = '${token}';`,
      errors: [{ messageId: 'layer' as const, data: { token } }],
    })),
    ...[
      '[@media(min-width:700px)]:p-4',
      '[@container(min-width:30rem)]:p-4',
      '[@supports(display:grid)]:grid',
      '@min-[30rem]:p-4',
      'max-[40rem]:p-4',
    ].map((token) => ({
      code: `const c = '${token}';`,
      errors: [arbitrary(token)],
    })),
    ...[
      'opacity-50',
      'hover:opacity-80',
      'backdrop-opacity-40',
      'opacity-2.5',
      'opacity-12.5',
      'bg-ink/12.5',
      'bg-ink/50',
      'text-state-broken-text/0.5',
    ].map((token) => ({
      code: `const c = '${token}';`,
      errors: [{ messageId: 'opacity' as const, data: { token } }],
    })),
    {
      code: `const c = 'delay-150';`,
      errors: [{ messageId: 'delay', data: { token: 'delay-150' } }],
    },
    {
      code: `const c = 'duration-200';`,
      errors: [{ messageId: 'duration', data: { token: 'duration-200' } }],
    },
    ...(
      [
        ['duration-150.5', 'duration'],
        ['delay-7.5', 'delay'],
      ] as const
    ).map(([token, messageId]) => ({
      code: `const c = '${token}';`,
      errors: [{ messageId, data: { token } }],
    })),
  ],
});

describe('fixture', () => {
  it('reports every bad line of a component file and nothing on the good ones', async () => {
    const eslint = new ESLint({
      cwd: here,
      overrideConfigFile: true,
      overrideConfig: {
        files: ['**/*.tsx'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        plugins: { drefyn: plugin },
        rules: { 'drefyn/no-arbitrary-values': 'error' },
      },
    });
    const file = join(here, 'fixtures/classes.tsx');
    const [result] = await eslint.lintFiles([file]);
    const source = readFileSync(file, 'utf8').split('\n');
    const reported = new Set(result?.messages.map((m) => m.line));
    const bad = source.flatMap((l, i) => (l.includes('bad') && !l.startsWith('//') ? [i + 1] : []));
    const good = source.flatMap((l, i) => (l.includes('>good<') ? [i + 1] : []));
    // The first bad marker is on the line after the opening div, which carries its own error.
    const opening = source.findIndex((l) => l.includes('p-[13px]')) + 1;
    expect([...reported].sort((a, b) => a - b)).toEqual([opening, ...bad]);
    for (const line of good) expect(reported.has(line), `line ${line}`).toBe(false);
    expect(result?.messages.every((m) => m.severity === 2)).toBe(true);
    expect(result?.messages[0]?.message).toBe(
      "'p-[13px]' is an arbitrary value. Use a utility from the token theme, or add a token.",
    );
  });

  it('is switched on for packages/ui and apps in the repo config, and off elsewhere', async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const at = async (path: string) =>
      (
        (await eslint.calculateConfigForFile(join(repoRoot, path))) as {
          rules?: Record<string, unknown>;
        }
      ).rules?.['drefyn/no-arbitrary-values'];
    expect(await at('packages/ui/src/button.tsx')).toEqual([2]);
    expect(await at('apps/dashboard/app/page.tsx')).toEqual([2]);
    expect(await at('scripts/hygiene/src/cli.ts')).toBeUndefined();
    expect(relative(repoRoot, here)).toBe('scripts/lint-rules/test');
  });
});
