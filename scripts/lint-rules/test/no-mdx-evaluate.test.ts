import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixture, makeEslint, reports } from './helpers.ts';

const RULE = 'drefyn/no-mdx-evaluate';
const root = fixture('mdx');
const code = readFileSync(join(root, 'packages/web/src/evaluate.ts'), 'utf8');
const eslint = makeEslint(root, { [RULE]: 'error' });

const lint = async (text: string) =>
  reports(await eslint.lintText(text, { filePath: join(root, 'packages/web/src/evaluate.ts') }));

describe('no-mdx-evaluate', () => {
  it('reports every way of loading the compiler, on the fixture', async () => {
    const found = await lint(code);
    expect(found.map((report) => report.line)).toEqual([1, 2, 3, 4, 6, 7, 8, 9, 10]);
    expect(new Set(found.map((report) => report.ruleId))).toEqual(new Set([RULE]));
    expect(found[0]?.message).toBe(
      "Customer MDX is never compiled or run. '@mdx-js/mdx' turns it into code; parse with @drefyn/mdx.",
    );
  });

  it('leaves a type only import alone, since nothing loads at run time', async () => {
    expect(await lint("import type { CompileOptions } from '@mdx-js/mdx';\n")).toEqual([]);
  });

  it.each(['@mdx-js/node-loader', '@mdx-js/loader', '@mdx-js/esbuild', '@mdx-js/rollup'])(
    'reports %s, which wraps the same compiler',
    async (name) => {
      expect(await lint(`import x from '${name}';\nexport default x;\n`)).toHaveLength(1);
    },
  );

  it.each(['remark-mdx', '@mdx-js/react', '@mdx-js/mdxish', '@drefyn/mdx', './mdx.ts'])(
    'leaves %s alone',
    async (name) => {
      expect(await lint(`import x from '${name}';\nexport default x;\n`)).toEqual([]);
    },
  );
});
