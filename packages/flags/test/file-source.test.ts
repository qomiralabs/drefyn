// The real flagd provider in offline file mode, no daemon. The mocked tests check what the
// client asks for; this checks the real provider does what those options promise.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlagClient, type FlagClient } from '../src/index.ts';
import {
  KILL_SAFE_ON,
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

  it('ignores FLAGD_* variables that would switch to RPC or another file', async () => {
    const ours = stateFile('flags.json', { [RELEASE]: false, [KILL_SAFE_ON]: false });
    const theirs = stateFile('theirs.json', { [RELEASE]: true, [KILL_SAFE_ON]: true });
    vi.stubEnv('FLAGD_RESOLVER', 'rpc');
    vi.stubEnv('FLAGD_OFFLINE_FLAG_SOURCE_PATH', theirs);
    vi.stubEnv('FLAGD_HOST', '127.0.0.1');
    vi.stubEnv('FLAGD_PORT', '1');
    const client = await start(ours);
    // From our file: not theirs (true, provider) and not an RPC failure (safe value true).
    expect(await client.evaluate(RELEASE, ctx)).toEqual({ value: false, source: 'provider' });
    expect(await client.evaluate(KILL_SAFE_ON, ctx)).toEqual({ value: false, source: 'provider' });
  });
});
