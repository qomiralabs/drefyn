import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

export interface GitResult {
  code: number;
  stdout: Buffer;
}

export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

export interface CarryResult {
  // Commits other than the head whose approvals count for it, nearest first.
  carried: string[];
  // Why the walk ended, or why it never started.
  stop: string;
}

export interface CarryOptions {
  // A checkout with full history and the PR head objects fetched.
  cwd: string;
  head: string;
  // The base branch ref, for example refs/remotes/origin/development.
  base: string;
  maxMerges?: number;
  git?: GitRunner;
}

const SHA = /^[0-9a-f]{40}$/;
const DEFAULT_MAX_MERGES = 50;
const TIMEOUT_MS = 60_000;

// Only the checkout decides what git reads: inherited GIT_DIR, GIT_INDEX_FILE or object
// directory variables would point it elsewhere. Replace refs and grafts can both make a
// plain commit look like a merge, so both are off. A command line -c outranks
// core.useReplaceRefs in the repository's own config.
function gitEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  return {
    ...env,
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_GRAFT_FILE: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
}

export function runGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.useReplaceRefs=false', ...args], {
      cwd,
      env: gitEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: TIMEOUT_MS,
    });
    const out: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.on('error', reject);
    // A kill on timeout leaves no exit code, which callers treat as a failure.
    child.on('close', (code: number | null) => {
      resolve({ code: code ?? -1, stdout: Buffer.concat(out) });
    });
  });
}

class GitError extends Error {}

interface Commit {
  tree: string;
  parents: string[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The walk never trusts what git says about a commit's parents: it reads the raw object,
// checks that the bytes hash to the SHA it asked for, and parses the header itself.
async function readCommit(git: GitRunner, cwd: string, sha: string): Promise<Commit> {
  const { code, stdout } = await git(['cat-file', 'commit', sha], cwd);
  if (code !== 0) throw new GitError(`cat-file could not read ${sha}`);
  const hash = createHash('sha1').update(`commit ${stdout.length}\0`).update(stdout).digest('hex');
  if (hash !== sha) throw new GitError(`commit ${sha} does not match its SHA`);
  const lines = stdout.toString('latin1').split('\n');
  const tree = /^tree ([0-9a-f]{40})$/.exec(lines[0] ?? '')?.[1];
  if (tree === undefined) throw new GitError(`commit ${sha} has no tree line`);
  const parents: string[] = [];
  for (const line of lines.slice(1)) {
    const parent = /^parent ([0-9a-f]{40})$/.exec(line)?.[1];
    if (parent === undefined) break;
    parents.push(parent);
  }
  return { tree, parents };
}

async function isAncestor(git: GitRunner, cwd: string, a: string, b: string): Promise<boolean> {
  const { code } = await git(['merge-base', '--is-ancestor', a, b], cwd);
  if (code === 0) return true;
  if (code === 1) return false;
  throw new GitError(`merge-base exited ${code}`);
}

// The tree git produces for a clean automatic merge, or undefined on conflicts.
async function cleanMerge(
  git: GitRunner,
  cwd: string,
  ours: string,
  theirs: string,
): Promise<string | undefined> {
  const { code, stdout } = await git(
    ['merge-tree', '--write-tree', '--no-messages', ours, theirs],
    cwd,
  );
  if (code === 1) return undefined;
  if (code !== 0) throw new GitError(`merge-tree exited ${code}`);
  const tree = stdout.toString('utf8').trim();
  if (!SHA.test(tree)) throw new GitError('merge-tree printed no tree id');
  return tree;
}

async function preflight(git: GitRunner, cwd: string, base: string, head: string) {
  const version = (await git(['version'], cwd)).stdout.toString('utf8').trim();
  const match = /^git version (\d+)\.(\d+)((?:\.\d+)?)/.exec(version);
  if (match === null) return { stop: 'git version unreadable' };
  const [, major = '0', minor = '0', patch = ''] = match;
  // merge-tree --write-tree arrived in 2.38.
  if (Number(major) < 2 || (Number(major) === 2 && Number(minor) < 38)) {
    return { stop: `git ${major}.${minor}${patch} is older than 2.38` };
  }

  const shallow = await git(['rev-parse', '--is-shallow-repository'], cwd);
  if (shallow.code !== 0) throw new GitError(`rev-parse exited ${shallow.code}`);
  const flag = shallow.stdout.toString('utf8').trim();
  if (flag === 'true') return { stop: 'history is shallow' };
  if (flag !== 'false') throw new GitError('rev-parse could not tell whether history is shallow');

  const tip = await git(
    ['rev-parse', '--verify', '--quiet', '--end-of-options', `${base}^{commit}`],
    cwd,
  );
  const baseTip = tip.stdout.toString('utf8').trim();
  if (tip.code !== 0 || !SHA.test(baseTip)) return { stop: `base ref ${base} not found` };

  const type = await git(['cat-file', '-t', head], cwd);
  if (type.code !== 0 || type.stdout.toString('utf8').trim() !== 'commit') {
    return { stop: `head ${head} not found` };
  }
  return { baseTip };
}

async function walk(
  git: GitRunner,
  cwd: string,
  head: string,
  baseTip: string,
  maxMerges: number,
): Promise<CarryResult> {
  const carried: string[] = [];
  let commit = head;
  for (let merges = 0; ; merges += 1) {
    const done = (stop: string): CarryResult => ({ carried, stop });
    if (merges === maxMerges) return done(`more than ${plural(maxMerges, 'merge')} in a row`);
    const { tree, parents } = await readCommit(git, cwd, commit);
    // Anything but exactly two parents is either an author's commit or a merge GitHub's
    // update branch never makes.
    if (parents.length < 2) return done(`${commit} is not a merge`);
    if (parents.length > 2) return done(`${commit} has ${parents.length} parents`);
    const [ours = '', theirs = ''] = parents;
    if (ours === theirs) return done(`${commit} lists the same parent twice`);
    // The second parent must already be reviewed work on the base branch, not another
    // branch the author controls.
    if (!(await isAncestor(git, cwd, theirs, baseTip))) {
      return done(`second parent ${theirs} of ${commit} is not on the base branch`);
    }
    // Following a first parent onto the base branch would leave the PR's own history.
    if (await isAncestor(git, cwd, ours, baseTip)) {
      return done(`first parent ${ours} of ${commit} is already on the base branch`);
    }
    const expected = await cleanMerge(git, cwd, ours, theirs);
    if (expected === undefined) return done(`${commit} resolves merge conflicts`);
    // Byte identical to git's own result, so the merge itself added, dropped or changed
    // nothing anywhere in the tree.
    if (expected !== tree) return done(`${commit} differs from a clean merge of its parents`);
    carried.push(ours);
    commit = ours;
  }
}

// Which older commits' approvals still hold for the head: each one reached from the head
// by first parents, through merges that only bring in the base branch and are exactly the
// clean automatic merge. Any doubt, git error included, carries nothing at all.
export async function carryOver(options: CarryOptions): Promise<CarryResult> {
  const git = options.git ?? runGit;
  const head = options.head.toLowerCase();
  if (!SHA.test(head)) return { carried: [], stop: 'head is not a full commit SHA' };
  try {
    const ready = await preflight(git, options.cwd, options.base, head);
    if (ready.baseTip === undefined) return { carried: [], stop: ready.stop };
    const max = options.maxMerges ?? DEFAULT_MAX_MERGES;
    return await walk(git, options.cwd, head, ready.baseTip, max);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { carried: [], stop: `git failed: ${detail}` };
  }
}
