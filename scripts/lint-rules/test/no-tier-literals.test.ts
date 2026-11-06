import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { fixture, makeEslint, reports, repoRoot } from './helpers.ts';

const RULE = 'drefyn/no-tier-literals';
const root = fixture('tiers');
const eslint = makeEslint(root, { [RULE]: 'error' });

const lintAt = async (path: string, code: string) =>
  reports(await eslint.lintText(code, { filePath: join(root, path) }));
const lint = (code: string) => lintAt('apps/dashboard/src/check.ts', code);

const badFile = 'apps/web/src/plan.ts';

const TIERS = ['free', 'starter', 'growth', 'scale', 'enterprise', 'self_hosted'];
const ADVICE = 'Read @drefyn/entitlements';

describe('no-tier-literals', () => {
  it('reports all four forms on the fixture, at error severity', async () => {
    const found = await lintAt(badFile, readFileSync(join(root, badFile), 'utf8'));
    expect(found.map((report) => report.line)).toEqual([1, 2, 3, 6]);
    expect(new Set(found.map((report) => report.ruleId))).toEqual(new Set([RULE]));
  });

  describe.each(TIERS)('with %s', (tier) => {
    it.each([
      ['===', `export const a = (t: string) => t === '${tier}';`],
      ['!==', `export const a = (t: string) => t !== '${tier}';`],
      ['==', `export const a = (t: string) => t == '${tier}';`],
      ['!=', `export const a = (t: string) => t != '${tier}';`],
      ['a literal on the left', `export const a = (t: string) => '${tier}' === t;`],
    ])('reports a comparison, %s', async (_form, code) => {
      const found = await lint(code);
      expect(found).toHaveLength(1);
      expect(found[0]?.ruleId).toBe(RULE);
      expect(found[0]?.message).toContain(ADVICE);
    });

    it('reports a switch case', async () => {
      const code = `export function a(t: string) {\n  switch (t) {\n    case '${tier}':\n      return 1;\n    default:\n      return 0;\n  }\n}\n`;
      expect((await lint(code)).map((report) => report.line)).toEqual([3]);
    });

    it.each(['includes', 'indexOf'])('reports %s on an array literal', async (method) => {
      expect(await lint(`export const a = (t: string) => ['${tier}'].${method}(t);`)).toHaveLength(
        1,
      );
    });

    it('reports includes on an array literal held by as const', async () => {
      expect(
        await lint(`export const a = (t: string) => (['${tier}', 'x'] as const).includes(t);`),
      ).toHaveLength(1);
    });
  });

  it('reports an object keyed by two tier names, in each way of writing a key', async () => {
    for (const code of [
      'export const a = { free: 1, growth: 2 };',
      "export const a = { 'free': 1, 'growth': 2 };",
      "export const a = { ['free']: 1, growth: 2 };",
      'const free = 1;\nconst scale = 2;\nexport const a = { free, scale, other: 3 };',
    ]) {
      expect(await lint(code), code).toHaveLength(1);
    }
  });

  it('counts tier keys past a spread, which has no key of its own', async () => {
    const code = 'const rest = {};\nexport const a = { ...rest, free: 1, growth: 2 };';
    expect(await lint(code)).toHaveLength(1);
  });

  it('reports a file outside every workspace, which no package can own', async () => {
    const outside = makeEslint(tmpdir(), { [RULE]: 'error' });
    const results = await outside.lintText("export const a = (t: string) => t === 'free';", {
      filePath: join(tmpdir(), 'check.ts'),
    });
    expect(reports(results).map((report) => report.ruleId)).toEqual([RULE]);
  });

  it('reports each form on its own, so a file of them shows them all', async () => {
    const code = [
      "export const a = (t: string) => t === 'free';",
      "export const b = (t: string) => ['scale'].includes(t);",
      'export const c = { free: 1, scale: 2 };',
    ].join('\n');
    expect((await lint(code)).map((report) => report.line)).toEqual([1, 2, 3]);
  });

  it.each([
    'packages/entitlements/src/table.ts',
    'packages/entitlements/test/table.test.ts',
    'packages/entitlements/bench/native.ts',
  ])('leaves the same code alone in %s', async (path) => {
    const code = [
      "export const a = (t: string) => t === 'growth';",
      "export const b = (t: string) => ['growth'].includes(t);",
      'export const c = { free: 1, growth: 2 };',
      "export function d(t: string) {\n  switch (t) {\n    case 'free':\n      return 1;\n    default:\n      return 0;\n  }\n}",
    ].join('\n');
    expect(await lintAt(path, code)).toEqual([]);
  });

  it('knows the package when ESLint runs from inside it, as each package lint does', async () => {
    const inside = makeEslint(join(root, 'packages/entitlements'), { [RULE]: 'error' });
    const code = "export const a = (t: string) => t === 'growth';";
    const results = await inside.lintText(code, {
      filePath: join(root, 'packages/entitlements/src/table.ts'),
    });
    expect(reports(results)).toEqual([]);
  });

  it('still reports from inside an app, whatever folder ESLint runs from', async () => {
    const inside = makeEslint(join(root, 'apps/web'), { [RULE]: 'error' });
    const results = await inside.lintText("export const a = (t: string) => t === 'growth';", {
      filePath: join(root, 'apps/web/src/check.ts'),
    });
    expect(reports(results)).toHaveLength(1);
  });

  it.each(['apps/packages/entitlements/src/x.ts', 'packages/entitlements-extra/src/x.ts'])(
    'does not mistake %s for the entitlements package',
    async (path) => {
      expect(await lintAt(path, "export const a = (t: string) => t === 'free';")).toHaveLength(1);
    },
  );

  it.each([
    ['an object with one tier name key', 'export const a = { free: true, label: 1 };'],
    ['a comparison with another string', "export const a = (t: string) => t === 'paid';"],
    ['a comparison with different case', "export const a = (t: string) => t === 'Free';"],
    ['a tier name in a template literal', 'export const a = (t: string) => t === `free`;'],
    ['a tier name inside a longer string', "export const a = (t: string) => t === 'free tier';"],
    ['a non equality comparison', "export const a = (t: string) => t < 'free';"],
    ['a tier name passed as an argument', "export const a = (f: (t: string) => 1) => f('free');"],
    [
      'includes on a variable',
      "const l = ['free'];\nexport const a = (t: string) => l.includes(t);",
    ],
    ['includes on a list with no tier', "export const a = (t: string) => ['a'].includes(t);"],
    ['another method on a tier list', "export const a = ['free', 'scale'].join(',');"],
    ['a computed includes', "export const a = (t: string) => ['free']['includes'](t);"],
    ['a computed key', 'const free = 1;\nexport const a = { [free]: 1, growth: 2 };'],
    ['a type', "export type A = 'free' | 'starter';"],
    ['a type keyed by tiers', 'export interface A {\n  free: 1;\n  scale: 2;\n}'],
    [
      'a switch case on another string',
      "export function a(t: string) {\n  switch (t) {\n    case 'x':\n      return 1;\n    default:\n      return 0;\n  }\n}",
    ],
    [
      'a default-only switch',
      'export function a(t: string) {\n  switch (t) {\n    default:\n      return 0;\n  }\n}',
    ],
  ])('leaves alone %s', async (_form, code) => {
    expect(await lint(code)).toEqual([]);
  });

  it('is on for every package and app in the repo config, as an error', async () => {
    const config = new ESLint({ cwd: repoRoot });
    for (const path of [
      'apps/dashboard/src/server/gate.ts',
      'packages/auth/src/organizations.ts',
      'packages/flags/src/client.ts',
      'scripts/lint-rules/src/index.ts',
    ]) {
      const resolved = (await config.calculateConfigForFile(join(repoRoot, path))) as {
        rules?: Record<string, unknown>;
      };
      expect(resolved.rules?.[RULE], path).toEqual([2]);
    }
  });

  it('is off for the one reviewed table of display names and nothing near it', async () => {
    const config = new ESLint({ cwd: repoRoot });
    const setting = async (path: string) => {
      const resolved = (await config.calculateConfigForFile(join(repoRoot, path))) as {
        rules?: Record<string, unknown>;
      };
      return resolved.rules?.[RULE];
    };
    expect(await setting('apps/dashboard/src/server/plan-labels.ts')).toEqual([0]);
    expect(await setting('apps/dashboard/src/server/plan-words.ts')).toEqual([2]);
  });
});
