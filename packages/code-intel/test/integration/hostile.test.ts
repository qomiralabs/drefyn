import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExtractHost, DEFAULT_EXTRACT_CONFIG } from '../../src/index.ts';
import type { ExtractHost, ExtractRequest } from '../../src/index.ts';
import { fixture, recordingLogger, SLOW_TYPESCRIPT, TENANT } from '../helpers.ts';
import { startRepoHost } from './repo-host.ts';
import type { RepoHost } from './repo-host.ts';

const TIMEOUT_MS = 60_000;
const LIMIT_MS = 500;

const file = (source: string, path = 'src/client.ts'): ExtractRequest => ({
  tenant: TENANT,
  path,
  language: 'typescript',
  source,
});

const hosts: (ExtractHost | RepoHost)[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) {
    if ('kill' in host) host.kill();
    else await host.close();
  }
});

describe('a file built to make a grammar slow', () => {
  it(
    'is stopped at the time limit on a real thread, and the next file still extracts',
    async () => {
      const { logger, lines } = recordingLogger();
      const host = createExtractHost(
        { ...DEFAULT_EXTRACT_CONFIG, timeoutMs: LIMIT_MS },
        { logger, onStuck: vi.fn() },
      );
      hosts.push(host);
      const before = await host.extract(file(fixture('typescript/client.ts')));
      expect(before.ok && before.value.symbols.length).toBe(23);

      const began = performance.now();
      expect(await host.extract(file(SLOW_TYPESCRIPT, 'src/slow.ts'))).toEqual({
        ok: false,
        error: 'code.timeout',
      });
      // The limit plus the kill, far short of the seconds the parse would have taken.
      expect(performance.now() - began).toBeLessThan(LIMIT_MS + DEFAULT_EXTRACT_CONFIG.killGraceMs);

      const after = await host.extract(file(fixture('typescript/client.ts')));
      expect(after).toEqual(before);
      expect(host.stats().threadsStarted).toBe(2);
      expect(
        lines.find((line) => line.event === 'code_intel.extract_refused')?.fields,
      ).toMatchObject({ code: 'code.timeout', path: 'src/slow.ts' });
    },
    TIMEOUT_MS,
  );

  it(
    'is stopped inside the host process under --permission, which keeps serving',
    async () => {
      const host = await startRepoHost(LIMIT_MS);
      hosts.push(host);
      expect(host.permission).toEqual({ child: false, worker: true, passwd: false });

      expect(await host.extract(file(SLOW_TYPESCRIPT))).toEqual({
        ok: false,
        error: 'code.timeout',
      });
      const after = await host.extract(file(fixture('typescript/client.ts')));
      expect(after.ok && after.value.symbols.map((symbol) => symbol.name)).toContain(
        'createClient',
      );
      expect(host.process.exitCode).toBeNull();
      expect(host.process.signalCode).toBeNull();
    },
    TIMEOUT_MS,
  );

  it(
    'is refused unread when it is over the byte limit',
    async () => {
      const host = await startRepoHost(LIMIT_MS);
      hosts.push(host);
      const huge = 'a'.repeat(DEFAULT_EXTRACT_CONFIG.maxSourceBytes + 1);
      expect(await host.extract(file(huge))).toEqual({ ok: false, error: 'code.too_large' });
    },
    TIMEOUT_MS,
  );
});
