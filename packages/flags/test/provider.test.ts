import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlagError, createFlagClient, type FlagClient, type FlagConfig } from '../src/index.ts';
import { FakeProvider } from './support/fake-provider.ts';
import { flagd, install, reset } from './support/flagd.ts';
import {
  entitlements,
  fileConfig,
  fixtureFlags,
  flagdConfig,
  recorders,
} from './support/fixtures.ts';

vi.mock('@openfeature/flagd-provider', () => import('./support/flagd.ts'));

const open: FlagClient<typeof fixtureFlags>[] = [];

async function start(config: FlagConfig) {
  install(new FakeProvider());
  const client = await createFlagClient(config, {
    entitlements: entitlements().reader,
    registry: fixtureFlags,
    ...recorders(),
  });
  open.push(client);
  return client;
}

beforeEach(() => {
  vi.useFakeTimers();
  reset();
});

afterEach(async () => {
  for (const client of open.splice(0)) await client.close();
  vi.useRealTimers();
});

type Options = Record<string, unknown>;
const only = (): Options => {
  expect(flagd.options).toHaveLength(1);
  return flagd.options[0] as Options;
};

// What the flagd provider's own env reader produces when every FLAGD_* variable is set,
// as a stray variable on a host or in a base image would. The provider spreads this under
// the options it is given, so any option the client leaves out comes from the host.
const HOSTILE_ENV: Options = {
  resolverType: 'rpc',
  offlineFlagSourcePath: '/tmp/someone-elses-flags.json',
  host: 'evil.example',
  port: 1,
  socketPath: '/tmp/evil.sock',
};

describe('the flagd provider', () => {
  it('is built in process reading the file in file mode', async () => {
    await start(fileConfig);
    expect(only()).toMatchObject({
      resolverType: 'in-process',
      offlineFlagSourcePath: '/etc/drefyn/flags.json',
    });
  });

  it('is built in process syncing from flagd in flagd mode', async () => {
    await start(flagdConfig);
    const options = only();
    expect(options).toMatchObject({
      resolverType: 'in-process',
      host: 'flagd.internal',
      port: 8015,
    });
    expect(options['offlineFlagSourcePath']).toBeUndefined();
  });

  it('stays in process when a caller smuggles a resolver into the config object', async () => {
    await start({ ...flagdConfig, resolverType: 'rpc' } as unknown as FlagConfig);
    expect(only()).toMatchObject({ resolverType: 'in-process' });
  });

  it('is built once per client', async () => {
    await start(fileConfig);
    expect(flagd.options).toHaveLength(1);
  });

  it('in file mode cannot be pointed at another file or switched to RPC by FLAGD_* variables', async () => {
    await start(fileConfig);
    const effective = { ...HOSTILE_ENV, ...only() };
    expect(effective['resolverType']).toBe('in-process');
    expect(effective['offlineFlagSourcePath']).toBe('/etc/drefyn/flags.json');
  });

  it('in flagd mode cannot be redirected to a file, socket or host by FLAGD_* variables', async () => {
    await start(flagdConfig);
    const effective = { ...HOSTILE_ENV, ...only() };
    expect(effective['resolverType']).toBe('in-process');
    expect(effective['offlineFlagSourcePath']).toBeUndefined();
    expect(effective['socketPath']).toBeUndefined();
    expect(effective['host']).toBe('flagd.internal');
    expect(effective['port']).toBe(8015);
  });
});

describe('createFlagClient refuses an invalid config before building a provider', () => {
  const bad: [string, unknown][] = [
    ['rpc source', { ...fileConfig, source: 'rpc' }],
    ['no source', { file: '/x.json', evalTimeoutMs: 50, initTimeoutMs: 2000 }],
    ['empty file', { ...fileConfig, file: '' }],
    ['zero eval timeout', { ...fileConfig, evalTimeoutMs: 0 }],
    ['negative eval timeout', { ...fileConfig, evalTimeoutMs: -1 }],
    ['NaN eval timeout', { ...fileConfig, evalTimeoutMs: Number.NaN }],
    ['infinite eval timeout', { ...fileConfig, evalTimeoutMs: Number.POSITIVE_INFINITY }],
    ['fractional eval timeout', { ...fileConfig, evalTimeoutMs: 1.5 }],
    ['negative init timeout', { ...fileConfig, initTimeoutMs: -1 }],
    ['flagd without host', { ...flagdConfig, host: '' }],
    ['flagd port 0', { ...flagdConfig, syncPort: 0 }],
    ['flagd port too high', { ...flagdConfig, syncPort: 70_000 }],
    ['flagd port as text', { ...flagdConfig, syncPort: '8015' }],
    ['null', null],
  ];

  it.each(bad)('%s', async (_label, config) => {
    install(new FakeProvider());
    const outcome = createFlagClient(config as FlagConfig, {
      entitlements: entitlements().reader,
      registry: fixtureFlags,
    });
    await expect(outcome).rejects.toBeInstanceOf(FlagError);
    await expect(outcome).rejects.toMatchObject({ code: 'FLAG_CONFIG_INVALID' });
    expect(flagd.options).toHaveLength(0);
  });
});
