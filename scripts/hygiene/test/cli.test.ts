import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import { CO_AUTHOR, EM_DASH, makeRepo, type TempRepo } from './helpers.ts';

// Fixture repos are built once before the tests, since spawning git is slow under load.
const repos = {} as Record<'clean' | 'dirty' | 'trailer' | 'cleanRange', TempRepo>;
const bases: Record<string, string> = {};
let textDir = '';

beforeAll(() => {
  const withReadme = () => {
    const r = makeRepo();
    r.write('README.md', '# Clean\n');
    return r;
  };
  repos.clean = withReadme();
  repos.clean.stage();

  repos.dirty = withReadme();
  repos.dirty.write('CLAUDE.md', 'x\n');
  repos.dirty.write('a.md', `x ${EM_DASH}\n`);
  repos.dirty.stage();

  repos.trailer = withReadme();
  bases['trailer'] = repos.trailer.commit('chore: start\n');
  repos.trailer.write('b.md', 'b\n');
  repos.trailer.commit(`feat: b\n\n${CO_AUTHOR}: x <x@y.z>\n`);

  repos.cleanRange = withReadme();
  bases['cleanRange'] = repos.cleanRange.commit('chore: start\n');
  repos.cleanRange.write('b.md', 'b\n');
  repos.cleanRange.commit('feat: b\n');

  textDir = mkdtempSync(join(tmpdir(), 'hygiene-cli-text-'));
  writeFileSync(join(textDir, 'title.txt'), 'ci: fine');
  writeFileSync(join(textDir, 'body.txt'), `Body\nGenerated with Tool\n`);
});

afterAll(() => {
  for (const r of Object.values(repos)) r.cleanup();
  rmSync(textDir, { recursive: true, force: true });
});

async function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  let out = '';
  let err = '';
  const code = await main(args, env, {
    out: (s) => (out += s),
    err: (s) => (err += s),
  });
  return { code, out, err };
}

describe('hygiene cli', () => {
  it('checks tracked files by default and exits 0 when clean', async () => {
    const res = await run(['--cwd', repos.clean.dir]);
    expect(res.code).toBe(0);
    expect(res.out).toContain('hygiene: clean');
    expect(res.out).toContain('1 tracked files');
  });

  it('exits 1 and lists findings when tracked files are dirty', async () => {
    const res = await run(['--files', '--cwd', repos.dirty.dir]);
    expect(res.code).toBe(1);
    expect(res.err).toContain('CLAUDE.md: internal-path');
    expect(res.err).toContain('a.md:1:3: dash: U+2014 em dash');
    expect(res.err).toContain('hygiene: 2 problems');
  });

  it('checks a commit range', async () => {
    const res = await run([
      '--commits',
      `${bases['trailer'] ?? ''}..HEAD`,
      '--cwd',
      repos.trailer.dir,
    ]);
    expect(res.code).toBe(1);
    expect(res.err).toContain('co-author');
  });

  it('reports the commit count when the range is clean', async () => {
    const res = await run([
      '--commits',
      `${bases['cleanRange'] ?? ''}..HEAD`,
      '--cwd',
      repos.cleanRange.dir,
    ]);
    expect(res.code).toBe(0);
    expect(res.out).toContain('1 commits');
  });

  it('reads the PR title and body from the environment', async () => {
    const res = await run(['--pr'], {
      HYGIENE_PR_TITLE: `ci: a ${EM_DASH} b`,
      HYGIENE_PR_BODY: 'clean',
    });
    expect(res.code).toBe(1);
    expect(res.err).toContain('pr title:1:7: dash');
  });

  it('passes a clean PR from the environment', async () => {
    const res = await run(['--pr'], { HYGIENE_PR_TITLE: 'ci: fine', HYGIENE_PR_BODY: 'Fine.' });
    expect(res.code).toBe(0);
    expect(res.out).toContain('pull request');
  });

  it('reads the PR title and body from files', async () => {
    const res = await run([
      '--pr-title-file',
      join(textDir, 'title.txt'),
      '--pr-body-file',
      join(textDir, 'body.txt'),
    ]);
    expect(res.code).toBe(1);
    expect(res.err).toContain('pr body:2: generated-with');
  });

  it('refuses --pr without a title so a broken workflow cannot pass silently', async () => {
    const res = await run(['--pr'], {});
    expect(res.code).toBe(2);
    expect(res.err).toContain('HYGIENE_PR_TITLE');
  });

  it('exits 2 on an unknown flag', async () => {
    const res = await run(['--nope']);
    expect(res.code).toBe(2);
    expect(res.err).toContain('usage');
  });

  it('prints usage with --help', async () => {
    const res = await run(['--help']);
    expect(res.code).toBe(0);
    expect(res.out).toContain('usage');
  });

  it('exits 2 when git fails', async () => {
    const res = await run(['--commits', 'missing..HEAD', '--cwd', repos.clean.dir]);
    expect(res.code).toBe(2);
    expect(res.err).toContain('hygiene: error');
  });
});
