import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type Deps } from '../src/cli.ts';

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

const member = (body: string, i: number) => ({
  author: 'lead',
  authorAssociation: 'MEMBER',
  createdAt: `2026-10-07T10:00:0${i}Z`,
  body,
});

const passingInput = {
  headSha: HEAD,
  labels: [],
  entries: ['code-reviewer', 'qa-verifier', 'hygiene-auditor'].map((r, i) => member(marker(r), i)),
};

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

  it('exits 2 on input with the wrong shape', async () => {
    const res = await run(['evaluate', '--input', writeInput({ headSha: HEAD, labels: 'x' })]);
    expect(res.code).toBe(2);
    expect(res.err).toContain('labels');
  });

  it('exits 2 on entries with the wrong shape', async () => {
    const res = await run([
      'evaluate',
      '--input',
      writeInput({ headSha: HEAD, labels: [], entries: [{ author: 'x' }] }),
    ]);
    expect(res.code).toBe(2);
    expect(res.err).toContain('entries');
  });

  it('exits 2 without --input', async () => {
    const res = await run(['evaluate']);
    expect(res.code).toBe(2);
    expect(res.err).toContain('--input');
  });
});

describe('review-gate github', () => {
  function respond(url: URL): Response {
    if (url.pathname === '/repos/o/r/pulls/3') {
      return Response.json({ head: { sha: HEAD }, labels: [] });
    }
    if (url.pathname === '/repos/o/r/issues/3/comments') {
      return Response.json(
        passingInput.entries.map((e) => ({
          user: { login: e.author },
          author_association: e.authorAssociation,
          created_at: e.createdAt,
          body: e.body,
        })),
      );
    }
    return Response.json([]);
  }
  const fakeFetch: typeof fetch = (input) =>
    Promise.resolve(respond(new URL(input instanceof Request ? input.url : input)));

  it('loads the PR from the API and evaluates it', async () => {
    const output = join(dir, 'out.txt');
    const res = await run(
      ['github', '--repo', 'o/r', '--pr', '3', '--github-output', output],
      { GITHUB_TOKEN: 't', GITHUB_API_URL: 'https://api.example.test' },
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

describe('review-gate usage', () => {
  it('prints usage with --help', async () => {
    const res = await run(['--help']);
    expect(res.code).toBe(0);
    expect(res.out).toContain('usage');
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
