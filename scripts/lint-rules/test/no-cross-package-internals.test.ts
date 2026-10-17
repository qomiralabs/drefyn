import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { fixture, makeEslint, repoRoot, reports } from './helpers.ts';

const RULE = 'drefyn/no-cross-package-internals';
const root = fixture('boundaries');
const eslint = makeEslint(root, { [RULE]: 'error' });

const internal = (spec: string) =>
  `'${spec}' reaches into @drefyn/x internals. Import from '@drefyn/x' instead.`;
const undeclared = (pkg: string) =>
  `'${pkg}' is not a declared dependency of @drefyn/z. Add it with workspace:*.`;

describe('no-cross-package-internals on the bad fixture', () => {
  it('reports every relative and bare deep import form with its message', async () => {
    const found = reports(await eslint.lintFiles(['packages/y/src/bad.ts']));
    const spec = '../../x/src/internal.ts';
    expect(found).toEqual([
      { line: 2, ruleId: RULE, message: internal(spec) }, // value import
      { line: 3, ruleId: RULE, message: internal(spec) }, // import type
      { line: 4, ruleId: RULE, message: internal(spec) }, // export { } from
      { line: 5, ruleId: RULE, message: internal(spec) }, // export * from
      { line: 6, ruleId: RULE, message: internal(spec) }, // import()
      { line: 7, ruleId: RULE, message: internal(spec) }, // import('...').T
      { line: 8, ruleId: RULE, message: internal(spec) }, // require()
      { line: 9, ruleId: RULE, message: internal(spec) }, // import(`...`)
      { line: 10, ruleId: RULE, message: internal('../../x') }, // the package directory itself
      {
        line: 11,
        ruleId: RULE,
        message:
          "'@drefyn/x/src/internal.ts' is not an entry point of @drefyn/x. " +
          'Public entry points: @drefyn/x, @drefyn/x/testing, @drefyn/x/package.json.',
      },
      { line: 14, ruleId: RULE, message: internal(spec) }, // import x = require()
    ]);
  });

  it('reports a @drefyn package the importer does not declare, in every import form', async () => {
    const found = reports(await eslint.lintFiles(['packages/z/src/index.ts']));
    expect(found).toEqual([
      { line: 2, ruleId: RULE, message: undeclared('@drefyn/x') },
      { line: 3, ruleId: RULE, message: undeclared('@drefyn/x') },
      { line: 4, ruleId: RULE, message: undeclared('@drefyn/x') },
      { line: 5, ruleId: RULE, message: undeclared('@drefyn/missing') },
    ]);
  });
});

describe('no-cross-package-internals on good input', () => {
  it('leaves same package, public, builtin, URL, # and absolute imports alone', async () => {
    const found = reports(
      await eslint.lintFiles([
        'packages/y/src/good.ts',
        'packages/y/test/own.test.ts',
        'packages/x/src/index.ts',
      ]),
    );
    expect(found).toEqual([]);
  });

  it('does not crash or report on odd specifiers', async () => {
    const code = [
      "import a from '';",
      "import b from '@drefyn';",
      "import c from '@drefyn/';",
      "import d from 'C:\\\\drefyn\\\\x.ts';",
      "import e from 'file:///tmp/x.ts';",
      "export const f = () => import(`../../x/${'src'}/internal.ts`);",
      'export const g = require(name);',
      'export const h = require();',
      'export const all = [a, b, c, d, e];',
    ].join('\n');
    const results = await eslint.lintText(code, { filePath: join(root, 'packages/y/src/odd.ts') });
    // '@drefyn' and '@drefyn/' are not package names, and a computed or missing
    // specifier cannot be resolved, so none of these is a workspace import.
    expect(reports(results)).toEqual([]);
  });

  it('reports nothing for a file outside any workspace', async () => {
    const outside = makeEslint(tmpdir(), { [RULE]: 'error' });
    const code =
      "import { x } from '../../x/src/internal.ts';\nimport y from '@drefyn/x';\nexport { x, y };";
    const results = await outside.lintText(code, { filePath: join(tmpdir(), 'a', 'b', 'c.ts') });
    expect(reports(results)).toEqual([]);
  });
});

describe('no-cross-package-internals in this repository', () => {
  const repo = makeEslint(repoRoot, { [RULE]: 'error' });

  it('finds owners from the real pnpm-workspace.yaml', async () => {
    const code = "import { evaluate } from '../../review-gate/src/gate.ts';\nexport { evaluate };";
    const results = await repo.lintText(code, {
      filePath: join(repoRoot, 'scripts/hygiene/src/probe.ts'),
    });
    expect(reports(results)).toEqual([
      {
        line: 1,
        ruleId: RULE,
        message:
          "'../../review-gate/src/gate.ts' reaches into @drefyn/review-gate internals. " +
          "Import from '@drefyn/review-gate' instead.",
      },
    ]);
  });

  it('lets packages use the shared root config files', async () => {
    const code = "import { sharedConfig } from '../../vitest.shared.ts';\nexport { sharedConfig };";
    const results = await repo.lintText(code, {
      filePath: join(repoRoot, 'scripts/hygiene/vitest.config.ts'),
    });
    expect(reports(results)).toEqual([]);
  });
});
