import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as gitModule from '../src/git.ts';
import { readBlobs } from '../src/git.ts';
import { checkCommits, checkPullRequest, checkTrackedFiles } from '../src/run.ts';
import { CO_AUTHOR, EM_DASH, EN_DASH, makeRepo, type TempRepo } from './helpers.ts';

// The real reader stays in place; one test swaps in a result with a blob missing,
// which real git cannot be made to produce.
vi.mock('../src/git.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof gitModule>();
  return { ...actual, readBlobs: vi.fn(actual.readBlobs) };
});

// Spawning git is slow on a loaded machine, so every fixture repo is built once, up
// front, and the tests only read them.
const made: TempRepo[] = [];
function fixture(build: (repo: TempRepo) => void): TempRepo {
  const repo = makeRepo();
  made.push(repo);
  build(repo);
  return repo;
}
afterAll(() => {
  for (const repo of made) repo.cleanup();
});

describe('checkTrackedFiles', () => {
  const repos = {} as Record<
    'clean' | 'dashes' | 'dashName' | 'internal' | 'staged' | 'untracked' | 'symlink' | 'empty',
    TempRepo
  >;
  let notGit = '';

  beforeAll(() => {
    repos.clean = fixture((r) => {
      r.write('README.md', '# Clean\n');
      r.write('src/a.ts', 'export const a = 1 - 2;\n');
      r.write('logo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xe2, 0x80, 0x94]));
      r.stage();
    });
    repos.dashes = fixture((r) => {
      r.write('docs/a.md', `ok\nbad ${EM_DASH} line\n`);
      r.write('src/b.ts', `// ${EN_DASH}\n`);
      r.stage();
    });
    repos.dashName = fixture((r) => {
      r.write(`notes/a${EN_DASH}b.md`, 'clean\n');
      r.stage();
    });
    repos.internal = fixture((r) => {
      r.write('.internal/plan.md', 'plan\n');
      r.write('apps/web/CLAUDE.md', 'rules\n');
      r.write('road.internal.md', 'x\n');
      r.stage();
    });
    repos.staged = fixture((r) => {
      r.write('a.md', `staged ${EM_DASH}\n`);
      r.stage();
      r.write('a.md', 'fixed on disk but not staged\n');
    });
    repos.untracked = fixture((r) => {
      r.write('tracked.md', 'clean\n');
      r.stage();
      r.write('scratch.md', `untracked ${EM_DASH}\n`);
    });
    repos.symlink = fixture((r) => {
      r.write('real.md', 'clean\n');
      execFileSync('ln', ['-s', `target${EM_DASH}.md`, 'link.md'], { cwd: r.dir });
      r.stage();
    });
    repos.empty = fixture(() => undefined);
    notGit = mkdtempSync(join(tmpdir(), 'hygiene-nogit-'));
  });
  afterAll(() => {
    rmSync(notGit, { recursive: true, force: true });
  });

  it('passes a clean repo and counts what it scanned', async () => {
    const result = await checkTrackedFiles(repos.clean.dir);
    expect(result.findings).toEqual([]);
    expect(result.scanned).toBe(2);
    expect(result.skippedBinary).toBe(1);
  });

  it('flags dashes in tracked text with positions', async () => {
    const { findings } = await checkTrackedFiles(repos.dashes.dir);
    expect(findings).toEqual([
      { rule: 'dash', source: 'docs/a.md', line: 2, column: 5, detail: 'U+2014 em dash' },
      { rule: 'dash', source: 'src/b.ts', line: 1, column: 4, detail: 'U+2013 en dash' },
    ]);
  });

  it('flags a dash in a tracked file name', async () => {
    const { findings } = await checkTrackedFiles(repos.dashName.dir);
    expect(findings).toEqual([
      {
        rule: 'dash',
        source: `notes/a${EN_DASH}b.md`,
        detail: 'U+2013 en dash in the file name',
      },
    ]);
  });

  it('flags tracked internal paths even when their content is clean', async () => {
    const { findings } = await checkTrackedFiles(repos.internal.dir);
    expect(findings.map((f) => f.source)).toEqual([
      '.internal/plan.md',
      'apps/web/CLAUDE.md',
      'road.internal.md',
    ]);
    expect(findings.every((f) => f.rule === 'internal-path')).toBe(true);
  });

  it('reads staged content, not the working tree', async () => {
    const { findings } = await checkTrackedFiles(repos.staged.dir);
    expect(findings).toHaveLength(1);
  });

  it('ignores untracked files', async () => {
    const { findings } = await checkTrackedFiles(repos.untracked.dir);
    expect(findings).toEqual([]);
  });

  it('checks symlink targets as text', async () => {
    const { findings } = await checkTrackedFiles(repos.symlink.dir);
    expect(findings.map((f) => f.source)).toEqual(['link.md']);
  });

  it('handles a repo with nothing tracked', async () => {
    const result = await checkTrackedFiles(repos.empty.dir);
    expect(result).toEqual({ findings: [], scanned: 0, skippedBinary: 0 });
  });

  it('fails instead of scanning a missing blob as empty', async () => {
    vi.mocked(readBlobs).mockResolvedValueOnce(new Map());
    await expect(checkTrackedFiles(repos.dashes.dir)).rejects.toThrow(
      /no blob was read for docs\/a\.md \([0-9a-f]{40}\)/,
    );
  });

  it('fails loudly outside a git repo', async () => {
    await expect(checkTrackedFiles(notGit)).rejects.toThrow(/git ls-files/);
  });
});

describe('checkCommits', () => {
  // One linear history; each test picks the range it needs.
  let repo: TempRepo;
  const sha: Record<string, string> = {};

  beforeAll(() => {
    repo = fixture((r) => {
      r.write('a.md', 'a\n');
      sha['old'] = r.commit(`chore: old ${EM_DASH}\n`);
      r.write('b.md', 'b\n');
      sha['base'] = r.commit('chore: base\n');
      r.write('c.md', 'c\n');
      sha['clean1'] = r.commit('feat: add c\n\nBecause c matters.\n');
      r.write('d.md', 'd\n');
      sha['clean2'] = r.commit('fix: d\n');
      r.write('e.md', 'e\n');
      sha['trailer'] = r.commit(`feat: e\n\nWhy.\n\n${CO_AUTHOR}: Someone <s@example.com>\n`);
      r.write('f.md', 'f\n');
      sha['afterTrailer'] = r.commit('fix: clean follow up\n');
      r.write('g.md', 'g\n');
      sha['dashy'] = r.commit(`feat: g ${EM_DASH} h\n\nGenerated with Tool\n`);
    });
  });

  const range = (from: string, to: string) => `${sha[from] ?? ''}..${sha[to] ?? ''}`;

  it('passes clean commits and counts them', async () => {
    expect(await checkCommits(repo.dir, range('base', 'clean2'))).toEqual({
      findings: [],
      commits: 2,
    });
  });

  it('flags a co-author trailer in any commit of the range, not only the last', async () => {
    const { findings } = await checkCommits(repo.dir, range('clean2', 'afterTrailer'));
    expect(findings).toEqual([
      {
        rule: 'co-author',
        source: `commit ${(sha['trailer'] ?? '').slice(0, 12)}`,
        line: 5,
        detail: 'co-author trailer',
      },
    ]);
  });

  it('flags dashes and generated lines in commit messages', async () => {
    const { findings } = await checkCommits(repo.dir, range('afterTrailer', 'dashy'));
    expect(findings.map((f) => f.rule)).toEqual(['dash', 'generated-with']);
  });

  it('ignores commits outside the range', async () => {
    const { findings } = await checkCommits(repo.dir, range('base', 'clean1'));
    expect(findings).toEqual([]);
  });

  it('returns zero commits for an empty range', async () => {
    expect(await checkCommits(repo.dir, 'HEAD..HEAD')).toEqual({ findings: [], commits: 0 });
  });

  it('rejects a bad range instead of passing silently', async () => {
    await expect(checkCommits(repo.dir, 'nope..HEAD')).rejects.toThrow(/git log/);
  });

  // Rejected before git runs, so no repo is needed at all.
  it('rejects a range that looks like an option', async () => {
    await expect(checkCommits(tmpdir(), '--output=/tmp/x')).rejects.toThrow(/range/);
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
