import { join } from 'node:path';
import { ESLint, Linter } from 'eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './helpers.ts';

// The React and Motion rules from the repo config. Typed rules need the file in a
// tsconfig project, which an in memory fixture is not, so each fixture is linted with
// exactly the settings the repo config resolves for its path, limited to these rules.
const UNDER_TEST = [
  'react-hooks/rules-of-hooks',
  'react-hooks/exhaustive-deps',
  'no-restricted-syntax',
  'no-restricted-imports',
];

const eslint = new ESLint({ cwd: repoRoot });

async function lint(path: string, code: string): Promise<string[]> {
  const resolved = (await eslint.calculateConfigForFile(join(repoRoot, path))) as {
    rules?: Linter.RulesRecord;
  };
  const rules: Linter.RulesRecord = {};
  for (const name of UNDER_TEST) {
    const setting = resolved.rules?.[name];
    if (setting !== undefined) rules[name] = setting;
  }
  const messages = new Linter({ configType: 'flat', cwd: repoRoot }).verify(
    code,
    [
      {
        files: ['**/*.{ts,tsx}'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        plugins: { 'react-hooks': { rules: reactHooks.rules } },
        rules,
      },
    ],
    { filename: join(repoRoot, path) },
  );
  return messages.map((m) => `${m.ruleId ?? 'parse'}: ${m.message}`);
}

const component = 'packages/ui/src/react/badge.tsx';

const conditionalHook = `
import { useState } from 'react';
export function Badge({ live }: { live: boolean }) {
  if (live) {
    const [n] = useState(0);
    return <span>{n}</span>;
  }
  return null;
}
`;
const missingDependency = `
'use client';
import { useEffect } from 'react';
export function Title({ text }: { text: string }) {
  useEffect(() => {
    document.title = text;
  }, []);
  return null;
}
`;

describe('the React rules', () => {
  it('reject a conditional hook call in a component and in an app', async () => {
    for (const path of [component, 'apps/dashboard/src/badge.tsx']) {
      expect(await lint(path, conditionalHook), path).toEqual([
        expect.stringMatching(
          /^react-hooks\/rules-of-hooks: React Hook "useState" is called conditionally/,
        ),
      ]);
    }
  });

  it('reject a missing effect dependency', async () => {
    expect(await lint(component, missingDependency)).toEqual([
      expect.stringMatching(
        /^react-hooks\/exhaustive-deps: React Hook useEffect has a missing dependency: 'text'/,
      ),
    ]);
  });

  it('pass the valid forms', async () => {
    const valid = `
'use client';
import { useEffect, useState } from 'react';
export function Title({ text }: { text: string }) {
  const [n] = useState(0);
  useEffect(() => {
    document.title = text + n;
  }, [text, n]);
  return <span className="text-body">{n}</span>;
}
`;
    expect(await lint(component, valid)).toEqual([]);
  });

  it('reject inline styles and raw HTML in components only', async () => {
    const style = 'export const A = () => <span style={{ color: "red" }}>A</span>;';
    const html =
      'export const B = (p: { h: string }) => <div dangerouslySetInnerHTML={{ __html: p.h }} />;';
    expect(await lint(component, style)).toEqual([
      'no-restricted-syntax: Style from token utilities, not inline styles.',
    ]);
    expect(await lint(component, html)).toEqual([
      'no-restricted-syntax: Components render text, never raw HTML.',
    ]);
    expect(await lint('packages/ui/src/react/icons/check.tsx', style)).toHaveLength(1);
    // Story layout is held by the token utilities rule, not by this one.
    expect(await lint('packages/ui/stories/a.stories.tsx', style)).toEqual([]);
  });
});

describe('the Motion rule', () => {
  const imports = [
    "import { m } from 'motion/react';",
    "import { animate } from 'motion';",
    "import { motion } from 'framer-motion';",
    "export { m } from 'motion/react-m';",
  ];

  it('rejects Motion in packages and in the docs app', async () => {
    for (const path of [component, 'packages/ui/src/charts.ts', 'apps/docs/src/page.tsx']) {
      for (const code of imports) {
        expect(await lint(path, code), `${path}: ${code}`).toEqual([
          expect.stringMatching(/Motion runs only in the dashboard and website/),
        ]);
      }
    }
  });

  it('rejects a dynamic Motion import outside the two apps', async () => {
    for (const path of [component, 'apps/status/src/page.tsx']) {
      expect(await lint(path, "void import('motion/react');"), path).toEqual([
        expect.stringMatching(/Motion runs only in the dashboard and website/),
      ]);
    }
  });

  it('allows Motion in the dashboard and the website', async () => {
    for (const path of ['apps/dashboard/src/shell.tsx', 'apps/website/src/hero.tsx']) {
      for (const code of [...imports, "void import('motion/react');"]) {
        expect(await lint(path, code), `${path}: ${code}`).toEqual([]);
      }
    }
  });

  it('leaves look alike packages alone', async () => {
    expect(await lint(component, "import { x } from 'motionless';")).toEqual([]);
  });
});
