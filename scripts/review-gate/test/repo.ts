import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Builds histories object by object, so a test can craft commits a normal git workflow
// would never produce: evil merges, reversed parents, octopus merges, replace refs.
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.test',
  GIT_AUTHOR_DATE: '2026-10-26T10:00:00Z',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.test',
  GIT_COMMITTER_DATE: '2026-10-26T10:00:00Z',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

export type Files = Record<string, string | null>;

export class Repo {
  readonly dir: string;
  #index: string;
  #count = 0;

  constructor(dir?: string) {
    this.dir = dir ?? mkdtempSync(join(tmpdir(), 'review-gate-repo-'));
    this.#index = join(this.dir, '.git', 'test-index');
    if (dir === undefined) this.git('init', '-q', '-b', 'development');
  }

  git(...args: string[]): string {
    return this.gitWith(undefined, ...args);
  }

  gitWith(input: string | undefined, ...args: string[]): string {
    return execFileSync('git', args, {
      cwd: this.dir,
      env: { ...ENV, GIT_INDEX_FILE: this.#index },
      encoding: 'utf8',
      ...(input === undefined ? {} : { input }),
    }).trim();
  }

  // A tree made from a base tree (or nothing) with some files written or removed.
  tree(from: string | undefined, files: Files): string {
    if (from === undefined) this.git('read-tree', '--empty');
    else this.git('read-tree', from);
    for (const [path, content] of Object.entries(files)) {
      if (content === null) {
        this.git('update-index', '--force-remove', '--', path);
      } else {
        const oid = this.gitWith(content, 'hash-object', '-w', '--stdin');
        this.git('update-index', '--add', '--cacheinfo', `100644,${oid},${path}`);
      }
    }
    return this.git('write-tree');
  }

  treeOf(commit: string): string {
    return this.git('rev-parse', `${commit}^{tree}`);
  }

  commitTree(tree: string, parents: string[], message?: string): string {
    this.#count += 1;
    const args = parents.flatMap((p) => ['-p', p]);
    return this.git('commit-tree', tree, ...args, '-m', message ?? `commit ${this.#count}`);
  }

  // An ordinary commit on top of one parent, or a root commit.
  commit(parent: string | undefined, files: Files): string {
    const tree = this.tree(parent === undefined ? undefined : this.treeOf(parent), files);
    return this.commitTree(tree, parent === undefined ? [] : [parent]);
  }

  // The tree git produces for a clean merge, as GitHub's update branch button does.
  cleanMergeTree(ours: string, theirs: string): string {
    return this.git('merge-tree', '--write-tree', ours, theirs);
  }

  merge(ours: string, theirs: string): string {
    return this.commitTree(this.cleanMergeTree(ours, theirs), [ours, theirs]);
  }

  // A merge commit whose tree is the clean result with extra edits on top.
  evilMerge(ours: string, theirs: string, files: Files): string {
    return this.commitTree(this.tree(this.cleanMergeTree(ours, theirs), files), [ours, theirs]);
  }

  // A private copy made with a file copy, not git: building the shared history spawns about
  // thirty git processes, which a starved host runs at seconds each. Commit numbering
  // carries on so a new commit never repeats an old message and collides with its SHA.
  clone(): Repo {
    const dir = mkdtempSync(join(tmpdir(), 'review-gate-repo-'));
    cpSync(this.dir, dir, { recursive: true });
    const copy = new Repo(dir);
    copy.#count = this.#count;
    return copy;
  }

  setBranch(name: string, sha: string): void {
    this.git('update-ref', `refs/heads/${name}`, sha);
  }

  remove(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export const BASE_REF = 'refs/heads/development';
