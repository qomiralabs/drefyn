import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scriptedSpawn } from './fake-git.ts';

let lsFiles = '';
const fake = scriptedSpawn(() => ({ stdout: lsFiles }));
const spawn = vi.fn(fake.spawn);

vi.mock('node:child_process', () => ({ spawn }));

const { listIndex } = await import('../src/git.ts');

const SHA1 = '0123456789abcdef0123456789abcdef01234567';
const SHA256 = '0123456789abcdef'.repeat(4);

function entry(oid: string, path: string, mode = '100644', stage = '0'): string {
  return `${mode} ${oid} ${stage}\t${path}\0`;
}

beforeEach(() => {
  lsFiles = '';
  spawn.mockClear();
});

describe('listIndex validates every ls-files record', () => {
  it('parses well formed records and drops submodules and later conflict stages', async () => {
    lsFiles =
      entry(SHA1, 'a.md') +
      entry(SHA1, 'sub', '160000') +
      entry(SHA1, 'c.md', '100644', '1') +
      entry(SHA1, 'c.md', '100644', '2') +
      entry(SHA1, 'path with\ttab.md');
    expect(await listIndex('/repo', 'sha1')).toEqual([
      { mode: '100644', oid: SHA1, path: 'a.md' },
      { mode: '100644', oid: SHA1, path: 'c.md' },
      { mode: '100644', oid: SHA1, path: 'path with\ttab.md' },
    ]);
  });

  it('accepts 64 character oids in a sha256 repository', async () => {
    lsFiles = entry(SHA256, 'a.md');
    expect(await listIndex('/repo', 'sha256')).toEqual([
      { mode: '100644', oid: SHA256, path: 'a.md' },
    ]);
  });

  it('rejects a record with no tab instead of reading the whole record as a path', async () => {
    lsFiles = entry(SHA1, 'a.md') + `100644 ${SHA1} 0 b.md\0`;
    await expect(listIndex('/repo', 'sha1')).rejects.toThrow(
      'git ls-files record 2 has no tab before the path',
    );
  });

  it.each([
    ['short', SHA1.slice(0, 39)],
    ['uppercase', SHA1.toUpperCase()],
    ['non hex', 'g'.repeat(40)],
    ['empty', ''],
    ['sha256 length in a sha1 repository', SHA256],
  ])('rejects an oid that is %s', async (_name, oid) => {
    lsFiles = entry(SHA1, 'a.md') + entry(oid, 'b.md');
    await expect(listIndex('/repo', 'sha1')).rejects.toThrow(
      'git ls-files record 2 has an invalid oid',
    );
  });

  it('rejects a sha1 length oid in a sha256 repository', async () => {
    lsFiles = entry(SHA1, 'a.md');
    await expect(listIndex('/repo', 'sha256')).rejects.toThrow(
      'git ls-files record 1 has an invalid oid',
    );
  });

  it.each([
    ['too few fields', `100644 ${SHA1}\ta.md\0`],
    ['too many fields', `100644 ${SHA1} 0 x\ta.md\0`],
    ['a bad mode', `10064x ${SHA1} 0\ta.md\0`],
    ['a bad stage', `100644 ${SHA1} 9\ta.md\0`],
    ['no path', `100644 ${SHA1} 0\t\0`],
  ])('rejects a record with %s', async (_name, record) => {
    lsFiles = record;
    await expect(listIndex('/repo', 'sha1')).rejects.toThrow(/^git ls-files record 1 /);
  });

  // The path is repository content and may be anything, so it stays out of the error.
  it('never echoes the record in its error', async () => {
    lsFiles = `100644 SECRET54${SHA1} 0\tSECRET54.md\0`;
    const error = await listIndex('/repo', 'sha1').then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('SECRET54');
  });
});
