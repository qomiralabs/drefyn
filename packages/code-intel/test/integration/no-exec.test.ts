import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { CODE_LANGUAGES } from '../../src/index.ts';
import type { CodeLanguage } from '../../src/index.ts';
import { fixture, SLOW_TYPESCRIPT, TENANT } from '../helpers.ts';
import { startRepoHost } from './repo-host.ts';
import type { RepoHost } from './repo-host.ts';

const TIMEOUT_MS = 60_000;

const FIXTURES: Record<CodeLanguage, string> = {
  typescript: 'typescript/client.ts',
  tsx: 'tsx/badge.tsx',
  javascript: 'javascript/counter.js',
  python: 'python/client.py',
  go: 'go/client.go',
  rust: 'rust/lib.rs',
};

// pgrep exits 1 when it finds nothing, which is the answer wanted here.
function childrenOf(pid: number): string[] {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .trim()
      .split('\n');
  } catch (error) {
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

let host: RepoHost | undefined;
afterEach(() => {
  host?.kill();
  host = undefined;
});

describe('extraction', () => {
  it(
    'starts no process besides the host, and the host may not start one',
    async () => {
      host = await startRepoHost(500);
      const pid = host.process.pid;
      if (pid === undefined) throw new Error('the host has no pid');
      expect(host.permission.child).toBe(false);

      for (const language of CODE_LANGUAGES) {
        const answer = await host.extract({
          tenant: TENANT,
          path: FIXTURES[language],
          language,
          source: fixture(FIXTURES[language]),
        });
        expect(answer.ok).toBe(true);
        expect(childrenOf(pid)).toEqual([]);
      }
      // A kill and a fresh thread are threads in the same process, never a new one.
      const slow = await host.extract({
        tenant: TENANT,
        path: 'slow.ts',
        language: 'typescript',
        source: SLOW_TYPESCRIPT,
      });
      expect(slow).toEqual({ ok: false, error: 'code.timeout' });
      expect(childrenOf(pid)).toEqual([]);
    },
    TIMEOUT_MS,
  );
});
