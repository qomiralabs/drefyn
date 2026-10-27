// The real flagd provider in offline file mode, no daemon. The mocked tests check what the
// client asks for; this checks the real provider does what those options promise.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenFeature } from '@openfeature/server-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlagClient, type FlagClient } from '../src/index.ts';
import {
  KILL_SAFE_ON,
  ORG,
  OTHER_ORG,
  RELEASE,
  ctx,
  entitlements,
  fixtureFlags,
  recorders,
} from './support/fixtures.ts';

let dir: string;
const open: FlagClient<typeof fixtureFlags>[] = [];

function stateFile(name: string, values: Record<string, boolean>): string {
  const path = join(dir, name);
  const entries = Object.fromEntries(
    Object.entries(values).map(([flag, on]) => [
      flag,
      { state: 'ENABLED', variants: { on: true, off: false }, defaultVariant: on ? 'on' : 'off' },
    ]),
  );
  writeFileSync(path, JSON.stringify({ flags: entries }));
  return path;
}

async function start(file: string, rec = recorders()) {
  const client = await createFlagClient(
    // A long init wait only bounds a broken run; a local file is read in milliseconds.
    { source: 'file', file, evalTimeoutMs: 1000, initTimeoutMs: 10_000 },
    { entitlements: entitlements().reader, registry: fixtureFlags, ...rec },
  );
  open.push(client);
  return client;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'drefyn-flags-'));
});

afterEach(async () => {
  OpenFeature.clearHooks();
  for (const client of open.splice(0)) await client.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('offline file mode with the real provider', { timeout: 15_000 }, () => {
  it('serves the values in the file', async () => {
    const client = await start(stateFile('flags.json', { [RELEASE]: true, [KILL_SAFE_ON]: false }));
    expect(await client.evaluate(RELEASE, ctx)).toEqual({ value: true, source: 'provider' });
    expect(await client.evaluate(KILL_SAFE_ON, ctx)).toEqual({ value: false, source: 'provider' });
  });

  it('judges targeting on the caller context, whatever a global hook returns', async () => {
    const path = join(dir, 'flags.json');
    // The rollout ladder: internal organizations first, then one named organization.
    const targeting = {
      if: [
        {
          or: [
            { '==': [{ var: 'internal' }, true] },
            { '==': [{ var: 'targetingKey' }, OTHER_ORG] },
            { '==': [{ var: 'organizationId' }, OTHER_ORG] },
          ],
        },
        'on',
        'off',
      ],
    };
    writeFileSync(
      path,
      JSON.stringify({
        flags: {
          [RELEASE]: {
            state: 'ENABLED',
            variants: { on: true, off: false },
            defaultVariant: 'off',
            targeting,
          },
        },
      }),
    );
    const client = await start(path);
    OpenFeature.addHooks({
      before: () => ({ internal: true, targetingKey: OTHER_ORG, organizationId: OTHER_ORG }),
      after: (_hookContext, details) => {
        Object.assign(details, { value: true });
      },
    });
    expect(await client.evaluate(RELEASE, { organizationId: ORG })).toEqual({
      value: false,
      source: 'provider',
    });
    expect(await client.evaluate(RELEASE, { organizationId: ORG, internal: true })).toEqual({
      value: true,
      source: 'provider',
    });
    expect(await client.evaluate(RELEASE, { organizationId: OTHER_ORG })).toEqual({
      value: true,
      source: 'provider',
    });
  });

  it('gives the safe value with FLAG_NOT_FOUND for a flag the file does not list', async () => {
    const client = await start(stateFile('flags.json', { [RELEASE]: true }));
    expect(await client.evaluate(KILL_SAFE_ON, ctx)).toEqual({
      value: true,
      source: 'safe_value',
      errorCode: 'FLAG_NOT_FOUND',
    });
  });

  it('resolves with safe values and logs when the file is missing', async () => {
    const rec = recorders();
    const client = await start(join(dir, 'missing.json'), rec);
    expect(rec.warn.mock.calls.map(([event]) => event)).toContain('flags.provider_not_ready');
    const release = await client.evaluate(RELEASE, ctx);
    expect(release.value).toBe(false);
    expect(release.source).toBe('safe_value');
    const kill = await client.evaluate(KILL_SAFE_ON, ctx);
    expect(kill.value).toBe(true);
    expect(kill.source).toBe('safe_value');
  });

  it('ignores every FLAGD_* variable, including ones that would switch to RPC or another file', async () => {
    const ours = stateFile('flags.json', { [RELEASE]: false, [KILL_SAFE_ON]: false });
    const theirs = stateFile('theirs.json', { [RELEASE]: true, [KILL_SAFE_ON]: true });
    // All 19 variables the provider reads.
    const hostile: Record<string, string> = {
      FLAGD_HOST: '127.0.0.1',
      FLAGD_PORT: '1',
      FLAGD_SYNC_PORT: '1',
      FLAGD_DEADLINE_MS: '1',
      FLAGD_STREAM_DEADLINE_MS: '1',
      FLAGD_TLS: 'true',
      FLAGD_SOCKET_PATH: join(dir, 'evil.sock'),
      FLAGD_SERVER_CERT_PATH: join(dir, 'evil.crt'),
      FLAGD_CACHE: 'lru',
      FLAGD_MAX_CACHE_SIZE: '1',
      FLAGD_SOURCE_SELECTOR: 'someone-elses-scope',
      FLAGD_RESOLVER: 'rpc',
      FLAGD_OFFLINE_FLAG_SOURCE_PATH: theirs,
      FLAGD_DEFAULT_AUTHORITY: 'evil.example',
      FLAGD_RETRY_BACKOFF_MS: '1',
      FLAGD_RETRY_BACKOFF_MAX_MS: '1',
      FLAGD_KEEP_ALIVE_TIME_MS: '1',
      FLAGD_FATAL_STATUS_CODES: 'UNAVAILABLE',
      FLAGD_RETRY_GRACE_PERIOD: '1',
    };
    expect(Object.keys(hostile)).toHaveLength(19);
    for (const [key, value] of Object.entries(hostile)) vi.stubEnv(key, value);
    const client = await start(ours);
    // From our file: not theirs (true, provider) and not an RPC failure (safe value true).
    expect(await client.evaluate(RELEASE, ctx)).toEqual({ value: false, source: 'provider' });
    expect(await client.evaluate(KILL_SAFE_ON, ctx)).toEqual({ value: false, source: 'provider' });
  });
});
