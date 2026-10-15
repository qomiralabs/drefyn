import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkCommits, checkPullRequest, checkTrackedFiles } from '../src/run.ts';
import { CO_AUTHOR, EM_DASH, EN_DASH, makeRepo, type TempRepo } from './helpers.ts';

let repo: TempRepo | undefined;

function newRepo(): TempRepo {
  repo = makeRepo();
  return repo;
}

afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

describe('checkTrackedFiles', () => {
  it('passes a clean repo and counts what it scanned', async () => {
    const r = newRepo();
    r.write('README.md', '# Clean\n');
    r.write('src/a.ts', 'export const a = 1 - 2;\n');
    r.write('logo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xe2, 0x80, 0x94]));
    r.stage();
    const result = await checkTrackedFiles(r.dir);
    expect(result.findings).toEqual([]);
    expect(result.scanned).toBe(2);
    expect(result.skippedBinary).toBe(1);
  });

  it('flags dashes in tracked text with positions', async () => {
    const r = newRepo();
    r.write('docs/a.md', `ok\nbad ${EM_DASH} line\n`);
    r.write('src/b.ts', `// ${EN_DASH}\n`);
    r.stage();
    const { findings } = await checkTrackedFiles(r.dir);
    expect(findings).toEqual([
      { rule: 'dash', source: 'docs/a.md', line: 2, column: 5, detail: 'U+2014 em dash' },
      { rule: 'dash', source: 'src/b.ts', line: 1, column: 4, detail: 'U+2013 en dash' },
    ]);
  });

  it('flags a dash in a tracked file name', async () => {
    const r = newRepo();
    r.write(`notes/a${EN_DASH}b.md`, 'clean\n');
    r.stage();
    const { findings } = await checkTrackedFiles(r.dir);
    expect(findings).toEqual([
      {
        rule: 'dash',
        source: `notes/a${EN_DASH}b.md`,
        detail: 'U+2013 en dash in the file name',
      },
    ]);
  });

  it('flags tracked internal paths even when their content is clean', async () => {
    const r = newRepo();
    r.write('.internal/plan.md', 'plan\n');
    r.write('apps/web/CLAUDE.md', 'rules\n');
    r.write('road.internal.md', 'x\n');
    r.stage();
    const { findings } = await checkTrackedFiles(r.dir);
    expect(findings.map((f) => f.source)).toEqual([
      '.internal/plan.md',
      'apps/web/CLAUDE.md',
      'road.internal.md',
    ]);
    expect(findings.every((f) => f.rule === 'internal-path')).toBe(true);
  });

  it('reads staged content, not the working tree', async () => {
    const r = newRepo();
    r.write('a.md', `staged ${EM_DASH}\n`);
    r.stage();
    r.write('a.md', 'fixed on disk but not staged\n');
    const { findings } = await checkTrackedFiles(r.dir);
    expect(findings).toHaveLength(1);
  });

  it('ignores untracked files', async () => {
    const r = newRepo();
    r.write('tracked.md', 'clean\n');
    r.stage();
    r.write('scratch.md', `untracked ${EM_DASH}\n`);
    const { findings } = await checkTrackedFiles(r.dir);
    expect(findings).toEqual([]);
  });

  it('checks symlink targets as text', async () => {
    const r = newRepo();
    r.write('real.md', 'clean\n');
    r.stage();
    execFileSync('ln', ['-s', `target${EM_DASH}.md`, 'link.md'], { cwd: r.dir });
    r.stage();
    const { findings } = await checkTrackedFiles(r.dir);
    expect(findings.map((f) => f.source)).toEqual(['link.md']);
  });

  it('handles a repo with nothing tracked', async () => {
    const r = newRepo();
    const result = await checkTrackedFiles(r.dir);
    expect(result).toEqual({ findings: [], scanned: 0, skippedBinary: 0 });
  });

  it('fails loudly outside a git repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hygiene-nogit-'));
    try {
      await expect(checkTrackedFiles(dir)).rejects.toThrow(/git ls-files/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('checkCommits', () => {
  it('passes clean commits and counts them', async () => {
    const r = newRepo();
    r.write('a.md', 'a\n');
    const base = r.commit('chore: start\n');
    r.write('b.md', 'b\n');
    r.commit('feat: add b\n\nBecause b matters.\n');
    r.write('c.md', 'c\n');
    r.commit('fix: c\n');
    const result = await checkCommits(r.dir, `${base}..HEAD`);
    expect(result).toEqual({ findings: [], commits: 2 });
  });

  it('flags a co-author trailer in any commit of the range, not only the last', async () => {
    const r = newRepo();
    r.write('a.md', 'a\n');
    const base = r.commit('chore: start\n');
    r.write('b.md', 'b\n');
    const bad = r.commit(`feat: b\n\nWhy.\n\n${CO_AUTHOR}: Someone <s@example.com>\n`);
    r.write('c.md', 'c\n');
    r.commit('fix: clean follow up\n');
    const { findings } = await checkCommits(r.dir, `${base}..HEAD`);
    expect(findings).toEqual([
      {
        rule: 'co-author',
        source: `commit ${bad.slice(0, 12)}`,
        line: 5,
        detail: 'co-author trailer',
      },
    ]);
  });

  it('flags dashes and generated lines in commit messages', async () => {
    const r = newRepo();
    r.write('a.md', 'a\n');
    const base = r.commit('chore: start\n');
    r.write('b.md', 'b\n');
    r.commit(`feat: b ${EM_DASH} c\n\nGenerated with Tool\n`);
    const { findings } = await checkCommits(r.dir, `${base}..HEAD`);
    expect(findings.map((f) => f.rule)).toEqual(['dash', 'generated-with']);
  });

  it('ignores commits outside the range', async () => {
    const r = newRepo();
    r.write('a.md', 'a\n');
    r.commit(`chore: old ${EM_DASH}\n`);
    r.write('b.md', 'b\n');
    const base = r.commit('chore: base\n');
    r.write('c.md', 'c\n');
    r.commit('feat: new\n');
    const { findings } = await checkCommits(r.dir, `${base}..HEAD`);
    expect(findings).toEqual([]);
  });

  it('returns zero commits for an empty range', async () => {
    const r = newRepo();
    r.write('a.md', 'a\n');
    r.commit('chore: start\n');
    expect(await checkCommits(r.dir, 'HEAD..HEAD')).toEqual({ findings: [], commits: 0 });
  });

  it('rejects a bad range instead of passing silently', async () => {
    const r = newRepo();
    r.write('a.md', 'a\n');
    r.commit('chore: start\n');
    await expect(checkCommits(r.dir, 'nope..HEAD')).rejects.toThrow(/git log/);
  });

  it('rejects a range that looks like an option', async () => {
    const r = newRepo();
    await expect(checkCommits(r.dir, '--output=/tmp/x')).rejects.toThrow(/range/);
  });
});

describe('checkPullRequest', () => {
  it('passes a clean title and body', () => {
    expect(checkPullRequest({ title: 'ci: add checks', body: '## Summary\nPlain.\n' })).toEqual([]);
  });

  it('flags a dash in the title and a trailer in the body', () => {
    const findings = checkPullRequest({
      title: `ci: checks ${EN_DASH} part one`,
      body: `## Summary\n\n${CO_AUTHOR}: x <x@y.z>\n`,
    });
    expect(findings.map((f) => [f.source, f.rule])).toEqual([
      ['pr title', 'dash'],
      ['pr body', 'co-author'],
    ]);
  });

  it('treats a missing body as empty', () => {
    expect(checkPullRequest({ title: 'docs: x' })).toEqual([]);
  });
});
