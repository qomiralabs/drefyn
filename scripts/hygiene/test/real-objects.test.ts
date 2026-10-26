import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import { objectFormat, readBlobs } from '../src/git.ts';
import { checkCommits, checkTrackedFiles } from '../src/run.ts';
import {
  EM_DASH,
  blobOid,
  git,
  makeRepo,
  supportsSha256,
  type ObjectFormat,
  type TempRepo,
} from './helpers.ts';

const made: TempRepo[] = [];
afterAll(() => {
  for (const repo of made) repo.cleanup();
});

function repoWith(format: ObjectFormat, build: (repo: TempRepo) => void): TempRepo {
  const repo = makeRepo(format);
  made.push(repo);
  build(repo);
  return repo;
}

// Points the staged blob of `path` at a clean blob, which is what a local replace ref
// does to anything that reads objects with replacement on.
function hideBlob(repo: TempRepo, path: string): void {
  const real = git(repo.dir, ['rev-parse', `:${path}`]);
  const clean = git(repo.dir, ['hash-object', '-w', '--stdin'], 'clean\n');
  git(repo.dir, ['replace', real, clean]);
}

// Swaps a commit for one with the same tree and parent but a clean message.
function hideMessage(repo: TempRepo, sha: string): void {
  const tree = git(repo.dir, ['rev-parse', `${sha}^{tree}`]);
  const parent = git(repo.dir, ['rev-parse', `${sha}^`]);
  const clean = git(repo.dir, ['commit-tree', tree, '-p', parent], 'feat: clean\n');
  git(repo.dir, ['replace', sha, clean]);
}

function capture(): {
  io: { out: (t: string) => void; err: (t: string) => void };
  text: () => string;
} {
  let text = '';
  return {
    io: { out: (t) => (text += t), err: (t) => (text += t) },
    text: () => text,
  };
}

const dashFinding = {
  rule: 'dash',
  source: 'a.md',
  line: 1,
  column: 5,
  detail: 'U+2014 em dash',
};

describe('replace refs cannot hide content from hygiene', () => {
  const repos = {} as Record<'blob' | 'blobConfig' | 'commit' | 'commitConfig', TempRepo>;
  const range: Record<string, string> = {};

  beforeAll(() => {
    repos.blob = repoWith('sha1', (r) => {
      r.write('a.md', `bad ${EM_DASH} line\n`);
      r.write('b.md', 'clean\n');
      r.stage();
      hideBlob(r, 'a.md');
    });
    // The repository's own config can turn replacement back on, which beats both the
    // environment variable and the --no-replace-objects flag on some git versions.
    repos.blobConfig = repoWith('sha1', (r) => {
      r.write('a.md', `bad ${EM_DASH} line\n`);
      r.stage();
      hideBlob(r, 'a.md');
      git(r.dir, ['config', 'core.useReplaceRefs', 'true']);
    });
    for (const name of ['commit', 'commitConfig'] as const) {
      repos[name] = repoWith('sha1', (r) => {
        r.write('a.md', 'a\n');
        const base = r.commit('chore: base\n');
        r.write('b.md', 'b\n');
        const dirty = r.commit(`feat: b ${EM_DASH} c\n`);
        hideMessage(r, dirty);
        if (name === 'commitConfig') git(r.dir, ['config', 'core.useReplaceRefs', 'true']);
        range[name] = `${base}..${dirty}`;
      });
    }
  });

  it('the fixture really hides the dash from a plain git read', () => {
    expect(git(repos.blob.dir, ['cat-file', '-p', `:a.md`])).toBe('clean');
    expect(git(repos.commit.dir, ['log', '-1', '--format=%s', 'HEAD'])).toBe('feat: clean');
  });

  it('reports a dash in a blob hidden by a replace ref', async () => {
    const { findings } = await checkTrackedFiles(repos.blob.dir);
    expect(findings).toEqual([dashFinding]);
  });

  it('reports it when the repository config turns replace refs on', async () => {
    const { findings } = await checkTrackedFiles(repos.blobConfig.dir);
    expect(findings).toEqual([dashFinding]);
  });

  it('exits 1 from the command line, as in the reported reproduction', async () => {
    const out = capture();
    expect(await main(['--files', '--cwd', repos.blob.dir], {}, out.io)).toBe(1);
    expect(out.text()).toContain('a.md:1:5: dash: U+2014 em dash');
  });

  it('reports a dash in a commit message hidden by a replace ref', async () => {
    const { findings } = await checkCommits(repos.commit.dir, range['commit'] ?? '');
    expect(findings.map((f) => [f.rule, f.detail])).toEqual([['dash', 'U+2014 em dash']]);
  });

  it('reports it when the repository config turns replace refs on', async () => {
    const { findings } = await checkCommits(repos.commitConfig.dir, range['commitConfig'] ?? '');
    expect(findings.map((f) => f.rule)).toEqual(['dash']);
  });
});

const sha256 = supportsSha256();
// CI must prove sha256, so the skip is only allowed on a developer machine.
const skipSha256 = !sha256 && process.env['CI'] === undefined;
const sha256Title = skipSha256 ? ' (skipped: this git cannot create sha256 repositories)' : '';

describe.skipIf(skipSha256)(`a sha256 repository${sha256Title}`, () => {
  let dirty: TempRepo;
  let clean: TempRepo;
  let hidden: TempRepo;

  beforeAll(() => {
    dirty = repoWith('sha256', (r) => {
      r.write('a.md', `bad ${EM_DASH} line\n`);
      r.stage();
    });
    clean = repoWith('sha256', (r) => {
      r.write('a.md', 'clean\n');
      r.write('b.md', 'also clean\n');
      r.stage();
    });
    hidden = repoWith('sha256', (r) => {
      r.write('a.md', `bad ${EM_DASH} line\n`);
      r.stage();
      hideBlob(r, 'a.md');
    });
  });

  it('is read as sha256', async () => {
    expect(await objectFormat(dirty.dir)).toBe('sha256');
  });

  it('passes clean content and reports a dash', async () => {
    expect((await checkTrackedFiles(clean.dir)).findings).toEqual([]);
    expect((await checkTrackedFiles(dirty.dir)).findings).toEqual([dashFinding]);
  });

  it('reports a dash hidden by a replace ref', async () => {
    expect((await checkTrackedFiles(hidden.dir)).findings).toEqual([dashFinding]);
  });
});

describe('the body hash agrees with git hash-object', () => {
  const formats: ObjectFormat[] = sha256 ? ['sha1', 'sha256'] : ['sha1'];
  const repos = new Map<ObjectFormat, TempRepo>();
  const bodies = [
    Buffer.alloc(0),
    Buffer.from('\n'),
    Buffer.from(`${EM_DASH}\r\n\0`),
    ...Array.from({ length: 6 }, (_, i) => randomBytes(1 + i * 997)),
  ];

  beforeAll(() => {
    for (const format of formats) {
      repos.set(
        format,
        repoWith(format, (r) => {
          bodies.forEach((body, i) => {
            r.write(`f${i}.bin`, body);
          });
          r.stage();
        }),
      );
    }
  });

  it.each(formats)('%s', async (format) => {
    const repo = repos.get(format);
    if (repo === undefined) throw new Error(`no ${format} repo`);
    const oids = bodies.map((_, i) => git(repo.dir, ['rev-parse', `:f${i}.bin`]));
    expect(oids).toEqual(bodies.map((body) => blobOid(body, format)));
    const blobs = await readBlobs(repo.dir, oids, format);
    expect(oids.map((oid) => blobs.get(oid))).toEqual(bodies);
  });
});
