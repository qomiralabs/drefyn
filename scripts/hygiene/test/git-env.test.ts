import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blobOid } from './oid.ts';
import { scriptedSpawn, subcommand } from './fake-git.ts';

const BODY = 'body\n';
const OID = blobOid(BODY);

const fake = scriptedSpawn((args) => {
  const [name] = subcommand(args);
  if (name === 'rev-parse') return { stdout: 'sha1\n' };
  if (name === 'ls-files') return { stdout: `100644 ${OID} 0\ta.md\0` };
  if (name === 'cat-file') return { stdout: `${OID} blob ${BODY.length}\n${BODY}\n` };
  if (name === 'log') return { stdout: `${'c'.repeat(40)}\nfeat: x\n\0` };
  return { stdout: 'git version 2.50.0\n' };
});
const spawn = vi.fn(fake.spawn);

vi.mock('node:child_process', () => ({ spawn }));

const git = await import('../src/git.ts');
const run = await import('../src/run.ts');

beforeEach(() => {
  fake.calls.length = 0;
});

// A replace ref swaps the object git hands back while keeping the oid that was asked
// for. The environment variable and the --no-replace-objects flag both lose to
// core.useReplaceRefs=true in the repository's own config, so the override has to be
// a command line -c, which outranks every config file.
function expectReplaceObjectsOff(): void {
  expect(fake.calls.length).toBeGreaterThan(0);
  for (const call of fake.calls) {
    expect(call.command).toBe('git');
    expect(call.args.slice(0, 2)).toEqual(['-c', 'core.useReplaceRefs=false']);
    expect(call.env?.['GIT_NO_REPLACE_OBJECTS']).toBe('1');
  }
}

describe('every git call runs with replace objects off', () => {
  it('runGit, with and without input', async () => {
    await git.runGit('/repo', ['--version']);
    await git.runGit('/repo', ['cat-file', '--batch'], `${OID}\n`);
    expectReplaceObjectsOff();
  });

  it('keeps the caller environment apart from the override', async () => {
    await git.runGit('/repo', ['--version']);
    expect(fake.calls[0]?.env?.['PATH']).toBe(process.env['PATH']);
  });

  it('names the subcommand, not the global options, in its errors', async () => {
    const failing = scriptedSpawn(() => ({ code: 128 }));
    spawn.mockImplementationOnce(failing.spawn);
    await expect(git.runGit('/repo', ['ls-files'])).rejects.toThrow(/^git ls-files failed/);
  });

  it('checkTrackedFiles: object format, ls-files and cat-file', async () => {
    await run.checkTrackedFiles('/repo');
    expect(fake.calls.map((call) => subcommand(call.args)[0])).toEqual([
      'rev-parse',
      'ls-files',
      'cat-file',
    ]);
    expectReplaceObjectsOff();
  });

  it('checkCommits: git log', async () => {
    await run.checkCommits('/repo', 'a..b');
    expect(fake.calls.map((call) => subcommand(call.args)[0])).toEqual(['log']);
    expectReplaceObjectsOff();
  });
});

describe('objectFormat', () => {
  it.each(['sha1', 'sha256'])('reads %s from git', async (format) => {
    spawn.mockImplementationOnce(scriptedSpawn(() => ({ stdout: `${format}\n` })).spawn);
    await expect(git.objectFormat('/repo')).resolves.toBe(format);
  });

  // An old git prints the unknown option back, which must not be taken as a format.
  it.each(['--show-object-format', 'sha512', ''])('rejects %j', async (output) => {
    spawn.mockImplementationOnce(scriptedSpawn(() => ({ stdout: `${output}\n` })).spawn);
    await expect(git.objectFormat('/repo')).rejects.toThrow(
      'git rev-parse gave an unsupported object format',
    );
  });
});
