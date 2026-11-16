import { describe, expect, it } from 'vitest';
import { isBranchName, parseGitSyncConfig } from '../src/index.ts';

describe('isBranchName', () => {
  it.each(['main', 'release/2026-11', 'feat/625-git-sync', 'v1.0', 'a'.repeat(255)])(
    'accepts %j',
    (name) => {
      expect(isBranchName(name)).toBe(true);
    },
  );

  it.each([
    '',
    '@',
    'a..b',
    'a@{1}',
    '-main',
    'main.',
    'main/',
    '/main',
    'a//b',
    '.hidden',
    'a/.b',
    'x.lock',
    'a/b.lock',
    'has space',
    'a~1',
    'a^',
    'a:b',
    'a?',
    'a*',
    'a[b',
    'a\\b',
    'a\u0000',
    'a'.repeat(256),
  ])('refuses %j', (name) => {
    expect(isBranchName(name)).toBe(false);
  });
});

describe('parseGitSyncConfig', () => {
  it('defaults the file cap', () => {
    expect(parseGitSyncConfig({})).toEqual({ ok: true, value: { maxFiles: 2000 } });
    expect(parseGitSyncConfig({ DREFYN_GIT_SYNC_MAX_FILES: '' })).toEqual({
      ok: true,
      value: { maxFiles: 2000 },
    });
  });

  it('reads a whole number up to its ceiling', () => {
    expect(parseGitSyncConfig({ DREFYN_GIT_SYNC_MAX_FILES: '500' })).toEqual({
      ok: true,
      value: { maxFiles: 500 },
    });
  });

  it.each(['0', '-1', '1.5', 'many', '100001', '0100'])('refuses %j', (raw) => {
    expect(parseGitSyncConfig({ DREFYN_GIT_SYNC_MAX_FILES: raw })).toEqual({
      ok: false,
      error: 'git_sync.config_invalid',
    });
  });
});
