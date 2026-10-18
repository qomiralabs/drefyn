import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findWorkspaceRoot, loadWorkspace, parseWorkspacePatterns } from '../src/workspace.ts';
import { repoRoot, tempWorkspace, type TempWorkspace } from './helpers.ts';

describe('parseWorkspacePatterns', () => {
  it('reads plain, quoted and commented entries and stops at the next key', () => {
    const yaml = [
      '# header',
      'packages:',
      '  - packages/*',
      "  - 'apps/*'",
      '  # a comment inside the list',
      '  - "scripts/*" # trailing comment',
      '',
      '  - "!packages/legacy"',
      'minimumReleaseAge: 4320',
      '  - not/a/package',
    ].join('\n');
    expect(parseWorkspacePatterns(yaml)).toEqual([
      'packages/*',
      'apps/*',
      'scripts/*',
      '!packages/legacy',
    ]);
  });

  it('reads an unindented block list, which YAML treats the same as an indented one', () => {
    const yaml = "packages:\n- 'packages/*'\n- apps/*\n# note\nminimumReleaseAge: 1\n";
    expect(parseWorkspacePatterns(yaml)).toEqual(['packages/*', 'apps/*']);
  });

  it('reads a quoted packages key', () => {
    expect(parseWorkspacePatterns('"packages":\n  - packages/*\n')).toEqual(['packages/*']);
    expect(parseWorkspacePatterns("'packages':\n- apps/*\n")).toEqual(['apps/*']);
  });

  it('refuses a missing or empty packages list instead of finding no packages', () => {
    expect(() => parseWorkspacePatterns('minimumReleaseAge: 4320\n')).toThrow(
      /pnpm-workspace.yaml: no packages list/,
    );
    expect(() => parseWorkspacePatterns('packages:\nminimumReleaseAge: 1\n')).toThrow(
      /pnpm-workspace.yaml: no packages list/,
    );
  });

  it('refuses an entry indented deeper than the first, which YAML reads as a continuation', () => {
    expect(() => parseWorkspacePatterns('packages:\n  - a/*\n    - b/*\n')).toThrow(
      /cannot read packages entry '- b\/\*'/,
    );
    expect(() => parseWorkspacePatterns('packages:\n- a/*\n  - b/*\n')).toThrow(
      /cannot read packages entry/,
    );
  });

  it('refuses a list form it cannot read rather than guessing', () => {
    expect(() => parseWorkspacePatterns('packages: [packages/*]\n')).toThrow(/cannot read/);
    expect(() => parseWorkspacePatterns('packages:\n  packages/*\n')).toThrow(/cannot read/);
  });
});

describe('loadWorkspace', () => {
  let ws: TempWorkspace | undefined;
  afterEach(() => {
    ws?.cleanup();
    ws = undefined;
  });

  it('expands dir/* and exact entries, honours negation and skips folders without a manifest', () => {
    ws = tempWorkspace(['packages/*', 'tools/one', '!packages/legacy', 'missing/*']);
    ws.manifest('packages/a', { name: '@drefyn/a' });
    ws.manifest('packages/legacy', { name: '@drefyn/legacy' });
    ws.write('packages/notes/README.md', 'no manifest here');
    ws.manifest('tools/one', { name: '@drefyn/one' });
    const loaded = loadWorkspace(ws.root);
    expect(loaded.packages.map((p) => [p.rel, p.name])).toEqual([
      ['packages/a', '@drefyn/a'],
      ['tools/one', '@drefyn/one'],
    ]);
    expect(loaded.rootManifest['name']).toBe('temp-root');
  });

  it('refuses glob forms it does not support', () => {
    ws = tempWorkspace(['packages/**']);
    expect(() => loadWorkspace(ws?.root ?? '')).toThrow(
      /unsupported workspace pattern 'packages\/\*\*'/,
    );
  });

  it('finds the repository root and its packages', () => {
    expect(findWorkspaceRoot(join(repoRoot, 'scripts/lint-rules/src'))).toBe(
      repoRoot.replace(/\/$/, ''),
    );
    const names = loadWorkspace(repoRoot).packages.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['@drefyn/hygiene', '@drefyn/lint-rules']));
  });

  it('returns undefined when no workspace file is above the path', () => {
    expect(findWorkspaceRoot('/')).toBeUndefined();
  });
});
