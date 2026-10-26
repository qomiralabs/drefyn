import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ObjectFormat } from './oid.ts';

export { blobOid, type ObjectFormat } from './oid.ts';

// Built from code points so the test sources never hold the characters they hunt for.
export const EN_DASH = String.fromCodePoint(0x2013);
export const EM_DASH = String.fromCodePoint(0x2014);
export const CO_AUTHOR = 'Co-' + 'authored-by';

// Keep the developer's own git config and hooks out of test repos.
export const gitEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  // The default user excludes file applies even without a global config.
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'core.excludesFile',
  GIT_CONFIG_VALUE_0: '/dev/null',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

export function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd,
    env: gitEnv,
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
  }).trim();
}

export interface TempRepo {
  dir: string;
  write: (path: string, content: string | Uint8Array) => void;
  stage: () => void;
  // Plumbing instead of `git commit` so no hook can rewrite the message.
  commit: (message: string) => string;
  cleanup: () => void;
}

export function makeRepo(format: ObjectFormat = 'sha1'): TempRepo {
  const dir = mkdtempSync(join(tmpdir(), 'hygiene-test-'));
  git(dir, ['init', '-q', '-b', 'main', `--object-format=${format}`]);
  let head: string | undefined;
  return {
    dir,
    write(path, content) {
      const full = join(dir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    },
    stage() {
      git(dir, ['add', '-A']);
    },
    commit(message) {
      git(dir, ['add', '-A']);
      const tree = git(dir, ['write-tree']);
      const parentArgs = head === undefined ? [] : ['-p', head];
      head = git(dir, ['commit-tree', tree, ...parentArgs], message);
      git(dir, ['update-ref', 'HEAD', head]);
      return head;
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Some older git builds cannot create sha256 repositories at all.
export function supportsSha256(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'hygiene-sha256-probe-'));
  try {
    execFileSync('git', ['init', '-q', '--object-format=sha256'], {
      cwd: dir,
      env: gitEnv,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
