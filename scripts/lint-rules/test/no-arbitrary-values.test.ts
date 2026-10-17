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
      'outline-offset-4',
      'ring-1',
      'ring-offset-2',
    ].map((token) => ({
      code: `const c = '${token}';`,
      errors: [{ messageId: 'stroke' as const, data: { token } }],
    })),
    ...['opacity-50', 'hover:opacity-80', 'backdrop-opacity-40'].map((token) => ({
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
