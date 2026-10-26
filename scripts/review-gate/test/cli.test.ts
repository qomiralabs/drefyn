import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type Deps } from '../src/cli.ts';
import { Repo } from './repo.ts';

const HEAD = 'd'.repeat(40);
const marker = (reviewer: string, verdict = 'approve') =>
  `<!-- drefyn-review reviewer=${reviewer} sha=${HEAD} verdict=${verdict} -->`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'review-gate-cli-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// The shipped rules file allows this login for every reviewer.
const member = (body: string, i: number) => ({
  author: 'Divine572',
  authorType: 'User',
  authorAssociation: 'MEMBER',
  submittedAt: `2026-10-07T10:00:0${i}Z`,
  body,
});

const passingInput = {
  headSha: HEAD,
  labels: [],
  files: ['README.md'],
  reviews: ['code-reviewer', 'qa-verifier'].map((r, i) => member(marker(r), i)),
};

const matcher = (part: Record<string, string[]> = {}) => ({
  prefixes: [],
  names: [],
  contains: [],
  suffixes: [],
  ...part,
});

async function run(args: string[], env: NodeJS.ProcessEnv = {}, deps: Deps = {}) {
  let out = '';
  let err = '';
  const code = await main(args, env, { out: (s) => (out += s), err: (s) => (err += s) }, deps);
  return { code, out, err };
}

function writeInput(value: unknown): string {
  const path = join(dir, 'input.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe('review-gate evaluate', () => {
  it('exits 0 and prints a PASS report', async () => {
    const res = await run(['evaluate', '--input', writeInput(passingInput)]);
    expect(res.code).toBe(0);
    expect(res.out).toContain('review-gate: PASS');
  });

  it('exits 1 and prints what is missing', async () => {
    const res = await run([
      'evaluate',
      '--input',
      writeInput({ ...passingInput, labels: ['needs-design'] }),
    ]);
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/design-reviewer\s+missing/);
  });

  it('needs the security reviewer when a changed path requires it', async () => {
    const res = await run([
      'evaluate',
      '--input',
      writeInput({ ...passingInput, files: ['.github/workflows/ci.yml'] }),
    ]);
    expect(res.code).toBe(1);
    expect(res.out).toMatch(
      /security-reviewer\s+missing \(tier A, path \.github\/workflows\/ci\.yml\)/,
    );
  });

  it('reads path rules from --rules', async () => {
    const rules = join(dir, 'rules.json');
    writeFileSync(
      rules,
      JSON.stringify({
        reviewers: {
          'code-reviewer': ['Divine572'],
          'qa-verifier': ['Divine572'],
          'design-reviewer': ['Divine572'],
        },
        paths: {
          security: matcher(),
          tests: matcher(),
          ui: matcher({ prefixes: ['apps/web/'] }),
          docs: matcher({ suffixes: ['.md'] }),
        },
      }),
    );
    const res = await run([
      'evaluate',
      '--input',
      writeInput({ ...passingInput, files: ['apps/web/page.tsx'] }),
      '--rules',
      rules,
    ]);
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/design-reviewer\s+missing \(ui path apps\/web\/page\.tsx\)/);
  });

  it('exits 2 on a broken rules file', async () => {
    const rules = join(dir, 'rules.json');
    writeFileSync(rules, '{"paths": "nope"}');
    const res = await run(['evaluate', '--input', writeInput(passingInput), '--rules', rules]);
    expect(res.code).toBe(2);
    expect(res.err).toContain('invalid rules');
  });

  it('exits 2 when the input has no files list, since path rules cannot be applied', async () => {
    const res = await run([
      'evaluate',
      '--input',
      writeInput({ headSha: HEAD, labels: [], reviews: passingInput.reviews }),
    ]);
    expect(res.code).toBe(2);
    expect(res.err).toContain('files');
  });

  it('honours edited and dismissed flags in the input', async () => {
    const reviews = passingInput.reviews.map((e, i) => (i === 0 ? { ...e, edited: true } : e));
    const res = await run(['evaluate', '--input', writeInput({ ...passingInput, reviews })]);
    expect(res.code).toBe(1);
    expect(res.out).toContain('(edited review; post a fresh one)');
  });

  it('exits 2 on an unknown review key, so a hand written lastEditedAt cannot silently do nothing', async () => {
    const reviews = passingInput.reviews.map((e) => ({
      ...e,
      lastEditedAt: '2026-10-07T12:00:00Z',
    }));
    const res = await run(['evaluate', '--input', writeInput({ ...passingInput, reviews })]);
    expect(res.code).toBe(2);
    expect(res.err).toContain('reviews[0] has unknown key lastEditedAt');
  });

  it('rejects the old entries key, since issue comments no longer carry markers', async () => {
    const { reviews, ...rest } = passingInput;
    const res = await run(['evaluate', '--input', writeInput({ ...rest, entries: reviews })]);
    expect(res.code).toBe(2);
    expect(res.err).toContain('unknown key entries');
  });

  it('exits 2 on an unknown top level key', async () => {
    const res = await run(['evaluate', '--input', writeInput({ ...passingInput, head: HEAD })]);
    expect(res.code).toBe(2);
    expect(res.err).toContain('unknown key head');
  });

  it('accepts reviews without an author association, since it is not used', async () => {
    const reviews = passingInput.reviews.map((e) => ({
      author: e.author,
      authorType: e.authorType,
      submittedAt: e.submittedAt,
      body: e.body,
    }));
    const res = await run(['evaluate', '--input', writeInput({ ...passingInput, reviews })]);
    expect(res.code).toBe(0);
  });

  it('exits 2 when a review has no author type, rather than guess it is a user', async () => {
    const reviews = passingInput.reviews.map((e) => ({
      author: e.author,
      submittedAt: e.submittedAt,
      body: e.body,
    }));
    const res = await run(['evaluate', '--input', writeInput({ ...passingInput, reviews })]);
    expect(res.code).toBe(2);
    expect(res.err).toContain('reviews[0] needs string author, authorType');
  });

  it('does not count a review whose author type is not User', async () => {
    const reviews = passingInput.reviews.map((e, i) => (i === 0 ? { ...e, authorType: 'Bot' } : e));
    const res = await run(['evaluate', '--input', writeInput({ ...passingInput, reviews })]);
    expect(res.code).toBe(1);
    expect(res.out).toContain('author is not a user account');
  });

  it('exits 2 when edited is not a boolean', async () => {
    const reviews = passingInput.reviews.map((e) => ({ ...e, edited: 'yes' }));
    const res = await run(['evaluate', '--input', writeInput({ ...passingInput, reviews })]);
    expect(res.code).toBe(2);
    expect(res.err).toContain('reviews[0]');
  });

  it('writes step outputs and a summary for the workflow', async () => {
    const output = join(dir, 'out.txt');
    const summary = join(dir, 'summary.md');
    writeFileSync(output, 'existing=1\n');
    const res = await run([
      'evaluate',
      '--input',
      writeInput({ ...passingInput, labels: ['needs-perf'] }),
      '--github-output',
      output,
      '--summary',
      summary,
    ]);
    expect(res.code).toBe(1);
    expect(readFileSync(output, 'utf8')).toBe(
      `existing=1\nstate=failure\nsha=${HEAD}\ndescription=missing: performance-reviewer\n`,
    );
    expect(readFileSync(summary, 'utf8')).toContain('```\nreview-gate: FAIL');
  });

  it('exits 2 on input that is not valid JSON', async () => {
    const path = join(dir, 'bad.json');
    writeFileSync(path, '{');
    const res = await run(['evaluate', '--input', path]);
    expect(res.code).toBe(2);
    expect(res.err).toContain('review-gate: error');
  });

  it('counts approvals on SHAs listed in carry and prints the carry note', async () => {
    const old = 'e'.repeat(40);
    const reviews = passingInput.reviews.map((e) => ({ ...e, body: e.body.replace(HEAD, old) }));
    const input = {
      ...passingInput,
      files: ['packages/core/src/a.ts'],
      reviews,
      carry: [old],
      carryNote: 'walked one merge',
    };
    const res = await run(['evaluate', '--input', writeInput(input)]);
    expect(res.code).toBe(0);
    expect(res.out).toContain('carry-over stopped: walked one merge');
  });

  it.each([
    ['carry is not a list', { carry: 'e' }],
    ['carry holds a non string', { carry: [1] }],
    ['carryNote is not a string', { carryNote: 3 }],
  ])('exits 2 when %s', async (_name, extra) => {
    const res = await run(['evaluate', '--input', writeInput({ ...passingInput, ...extra })]);
    expect(res.code).toBe(2);
    expect(res.err).toContain('carry');
  });

  it('exits 2 on a malformed carried SHA', async () => {
    const res = await run(['evaluate', '--input', writeInput({ ...passingInput, carry: ['abc'] })]);
    expect(res.code).toBe(2);
    expect(res.err).toContain('carried SHA');
  });

  it('exits 2 on input with the wrong shape', async () => {
    const res = await run(['evaluate', '--input', writeInput({ headSha: HEAD, labels: 'x' })]);
    expect(res.code).toBe(2);
    expect(res.err).toContain('labels');
  });

  it('exits 2 on reviews with the wrong shape', async () => {
    const res = await run([
      'evaluate',
      '--input',
      writeInput({ headSha: HEAD, labels: [], files: [], reviews: [{ author: 'x' }] }),
    ]);
    expect(res.code).toBe(2);
    expect(res.err).toContain('reviews');
  });

  it('exits 2 without --input', async () => {
    const res = await run(['evaluate']);
    expect(res.code).toBe(2);
    expect(res.err).toContain('--input');
  });
});

describe('review-gate github', () => {
  async function respond(url: URL, init: RequestInit | undefined): Promise<Response> {
    if (url.pathname === '/graphql') {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        query: string;
      };
      if (body.query.includes('comments(')) {
        return Response.json({ message: 'comments are not a marker source' }, { status: 400 });
      }
      const nodes = passingInput.reviews.map((e) => ({
        author: { __typename: e.authorType, login: e.author },
        authorAssociation: e.authorAssociation,
        submittedAt: e.submittedAt,
        lastEditedAt: null,
        state: 'COMMENTED',
        body: e.body,
      }));
      return Promise.resolve(
        Response.json({
          data: {
            repository: {
              pullRequest: {
                reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
              },
            },
          },
        }),
      );
    }
    if (url.pathname === '/repos/o/r/pulls/3') {
      return Response.json({ head: { sha: HEAD }, labels: [], changed_files: 1 });
    }
    if (url.pathname === '/repos/o/r/pulls/3/files') {
      return Response.json([{ filename: 'README.md' }]);
    }
    return Response.json({ message: 'Not Found' }, { status: 404 });
  }
  const fakeFetch: typeof fetch = (input, init) =>
    respond(new URL(input instanceof Request ? input.url : input), init);

  it('loads the PR from the API and evaluates it', async () => {
    const output = join(dir, 'out.txt');
    const res = await run(
      ['github', '--repo', 'o/r', '--pr', '3', '--github-output', output],
      {
        GITHUB_TOKEN: 't',
        GITHUB_API_URL: 'https://api.example.test',
        GITHUB_GRAPHQL_URL: 'https://api.example.test/graphql',
      },
      { fetch: fakeFetch, sleep: () => Promise.resolve() },
    );
    expect(res.code).toBe(0);
    expect(res.out).toContain('review-gate: PASS');
    expect(readFileSync(output, 'utf8')).toContain('state=success');
  });

  it('exits 2 without a token', async () => {
    const res = await run(['github', '--repo', 'o/r', '--pr', '3'], {}, { fetch: fakeFetch });
    expect(res.code).toBe(2);
    expect(res.err).toContain('GITHUB_TOKEN');
  });

  it('exits 2 on a non numeric PR', async () => {
    const res = await run(['github', '--repo', 'o/r', '--pr', 'abc'], { GITHUB_TOKEN: 't' });
    expect(res.code).toBe(2);
    expect(res.err).toContain('PR number');
  });

  it('exits 2 without --repo', async () => {
    const res = await run(['github', '--pr', '3'], { GITHUB_TOKEN: 't' });
    expect(res.code).toBe(2);
    expect(res.err).toContain('--repo');
  });
});

describe('review-gate github with history', () => {
  let repo: Repo;
  let X: string;
  let H: string;
  beforeEach(() => {
    repo = new Repo();
    const R = repo.commit(undefined, { 'packages/core/src/a.ts': 'v1\n', 'other.txt': 'o\n' });
    const D1 = repo.commit(R, { 'other.txt': 'o2\n' });
    // The workflow checks out with full history, so the base branch is a remote ref.
    repo.git('update-ref', 'refs/remotes/origin/development', D1);
    X = repo.commit(R, { 'packages/core/src/a.ts': 'v2\n' });
    H = repo.merge(X, D1);
  });
  afterEach(() => {
    repo.remove();
  });

  function api(base: unknown = { ref: 'development' }): typeof fetch {
    return (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === '/graphql') {
        const nodes = ['code-reviewer', 'qa-verifier'].map((r, i) => ({
          author: { __typename: 'User', login: 'Divine572' },
          authorAssociation: 'MEMBER',
          submittedAt: `2026-10-07T10:00:0${i}Z`,
          lastEditedAt: null,
          state: 'COMMENTED',
          body: `<!-- drefyn-review reviewer=${r} sha=${X} verdict=approve -->`,
        }));
        return Promise.resolve(
          Response.json({
            data: {
              repository: {
                pullRequest: {
                  reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
                },
              },
            },
          }),
        );
      }
      if (url.pathname === '/repos/o/r/pulls/3') {
        return Promise.resolve(
          Response.json({ head: { sha: H }, base, labels: [], changed_files: 1 }),
        );
      }
      if (url.pathname === '/repos/o/r/pulls/3/files') {
        return Promise.resolve(Response.json([{ filename: 'packages/core/src/a.ts' }]));
      }
      return Promise.resolve(Response.json({ message: 'Not Found' }, { status: 404 }));
    };
  }

  const env = (extra: NodeJS.ProcessEnv = {}) => ({
    GITHUB_TOKEN: 't',
    GITHUB_API_URL: 'https://api.example.test',
    ...extra,
  });

  it('carries approvals over a clean base merge when given the git directory', async () => {
    const res = await run(
      ['github', '--repo', 'o/r', '--pr', '3'],
      env({ REVIEW_GATE_GIT_DIR: repo.dir }),
      {
        fetch: api(),
      },
    );
    expect(res.out).toContain(`carry-over: approvals on these commits also count:\n  ${X}\n`);
    expect(res.code).toBe(0);
  });

  it('carries nothing without the git directory, so approvals must be on the head', async () => {
    const res = await run(['github', '--repo', 'o/r', '--pr', '3'], env(), { fetch: api() });
    expect(res.code).toBe(1);
    expect(res.out).toContain('carry-over: none (no git directory given)');
  });

  it('carries nothing when the PR names no base branch', async () => {
    const res = await run(
      ['github', '--repo', 'o/r', '--pr', '3'],
      env({ REVIEW_GATE_GIT_DIR: repo.dir }),
      {
        fetch: api(null),
      },
    );
    expect(res.code).toBe(1);
    expect(res.out).toContain('carry-over: none (the PR names no base branch)');
  });

  it('carries nothing when the base branch is not fetched', async () => {
    const res = await run(
      ['github', '--repo', 'o/r', '--pr', '3'],
      env({ REVIEW_GATE_GIT_DIR: repo.dir }),
      {
        fetch: api({ ref: 'staging' }),
      },
    );
    expect(res.code).toBe(1);
    expect(res.out).toContain('carry-over: none (base ref refs/remotes/origin/staging not found)');
  });

  it('exits 2 on a base branch name git could read as something else', async () => {
    const res = await run(
      ['github', '--repo', 'o/r', '--pr', '3'],
      env({ REVIEW_GATE_GIT_DIR: repo.dir }),
      {
        fetch: api({ ref: '--upload-pack=x' }),
      },
    );
    expect(res.code).toBe(2);
    expect(res.err).toContain('base branch');
  });
});

describe('review-gate usage', () => {
  it('prints usage with --help', async () => {
    const res = await run(['--help']);
    expect(res.code).toBe(0);
    expect(res.out).toContain('usage');
    expect(res.out).toContain('changed files and reviews from a JSON file');
    expect(res.out).not.toContain('comments');
  });

  it('exits 2 on an unknown command', async () => {
    const res = await run(['approve-everything']);
    expect(res.code).toBe(2);
    expect(res.err).toContain('usage');
  });

  it('exits 2 on an unknown flag', async () => {
    const res = await run(['evaluate', '--yolo']);
    expect(res.code).toBe(2);
  });
});
