import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import plugin from '../src/index.ts';

export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}/`, import.meta.url));

// Only the rules under test and a parser, so a fixture fails for one reason only.
export function makeEslint(cwd: string, rules: Linter.RulesRecord): ESLint {
  return new ESLint({
    cwd,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
      },
      {
        files: ['**/*.js'],
        languageOptions: { globals: { fetch: 'readonly', WebSocket: 'readonly' } },
      },
      { plugins: { drefyn: plugin }, rules },
    ],
  });
}

export interface Report {
  line: number;
  ruleId: string | null;
  message: string;
}

export function reports(results: ESLint.LintResult[]): Report[] {
  return results.flatMap((result) =>
    result.messages.map(({ line, ruleId, message }) => ({ line, ruleId, message })),
  );
}

export interface TempWorkspace {
  root: string;
  write: (path: string, content: string) => void;
  manifest: (dir: string, manifest: Record<string, unknown>) => void;
  cleanup: () => void;
}

export function tempWorkspace(patterns = ['packages/*', 'apps/*', 'scripts/*']): TempWorkspace {
  const root = mkdtempSync(join(tmpdir(), 'drefyn-lint-rules-'));
  const write = (path: string, content: string) => {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  write('pnpm-workspace.yaml', `packages:\n${patterns.map((p) => `  - ${p}\n`).join('')}`);
  write('package.json', JSON.stringify({ name: 'temp-root', private: true, type: 'module' }));
  // The checker reads the git index, as CI does.
  execFileSync('git', ['init', '-q'], { cwd: root });
  return {
    root,
    write,
    manifest: (dir, manifest) => {
      write(join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
    },
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export const SCRIPTS = { typecheck: 'tsc -p tsconfig.json', lint: 'eslint --max-warnings 0 .' };

// A private package that passes every manifest check; tests change one field at a time.
export function goodPackage(name: string, extra: Record<string, unknown> = {}) {
  return {
    name: `@drefyn/${name}`,
    private: true,
    version: '0.0.0',
    type: 'module',
    exports: { '.': './src/index.ts', './package.json': './package.json' },
    scripts: SCRIPTS,
    ...extra,
  };
}
