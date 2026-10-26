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
// the options it is given, so any option the client leaves out comes from the host. All 18
// options it reads are here, each with a value that would change behaviour.
const HOSTILE_ENV: Options = {
  resolverType: 'rpc',
  offlineFlagSourcePath: '/tmp/someone-elses-flags.json',
  host: 'evil.example',
  port: 1,
  socketPath: '/tmp/evil.sock',
  tls: true,
  certPath: '/tmp/evil.crt',
  selector: 'someone-elses-scope',
  defaultAuthority: 'evil.example',
  deadlineMs: 1,
  streamDeadlineMs: 1,
  keepAliveTime: 1,
  retryBackoffMs: 1,
  retryBackoffMaxMs: 1,
  retryGracePeriod: 100_000,
  fatalStatusCodes: ['UNAVAILABLE'],
  cache: 'lru',
  maxCacheSize: 1,
};

// Everything except where flags come from is the same in both modes.
const PINNED: Options = {
  resolverType: 'in-process',
  socketPath: undefined,
  tls: false,
  certPath: undefined,
  selector: '',
  defaultAuthority: undefined,
  deadlineMs: 500,
  streamDeadlineMs: 600_000,
  keepAliveTime: 0,
  retryBackoffMs: 1000,
  retryBackoffMaxMs: 5000,
  retryGracePeriod: 10,
  fatalStatusCodes: [],
  cache: 'disabled',
  maxCacheSize: 1000,
};

describe('the flagd provider', () => {
  it('pins every option the provider reads from FLAGD_* variables', () => {
    expect(Object.keys(HOSTILE_ENV)).toHaveLength(18);
  });

  it('is built in process reading the file in file mode, every option pinned', async () => {
    await start(fileConfig);
    expect(only()).toStrictEqual({
      ...PINNED,
      host: 'localhost',
      port: 8015,
      offlineFlagSourcePath: '/etc/drefyn/flags.json',
    });
  });

  it('is built in process syncing from flagd in flagd mode, every option pinned', async () => {
    await start(flagdConfig);
    expect(only()).toStrictEqual({
      ...PINNED,
      host: 'flagd.internal',
      port: 8015,
      offlineFlagSourcePath: undefined,
    });
  });

  it('sets every option explicitly, undefined included, so none falls through to the host', async () => {
    for (const config of [fileConfig, flagdConfig]) {
      reset();
      await start(config);
      expect(Object.keys(only()).sort()).toEqual(Object.keys(HOSTILE_ENV).sort());
    }
  });

  it('stays in process when a caller smuggles a resolver into the config object', async () => {
    await start({ ...flagdConfig, resolverType: 'rpc' } as unknown as FlagConfig);
    expect(only()).toMatchObject({ resolverType: 'in-process' });
  });

  it('is built once per client', async () => {
    await start(fileConfig);
    expect(flagd.options).toHaveLength(1);
  });

  it('in file mode keeps no hostile value at all', async () => {
    await start(fileConfig);
    const effective = { ...HOSTILE_ENV, ...only() };
    for (const [key, value] of Object.entries(HOSTILE_ENV)) {
      expect(effective[key], key).not.toEqual(value);
    }
    expect(effective['offlineFlagSourcePath']).toBe('/etc/drefyn/flags.json');
  });

  it('in flagd mode keeps no hostile value at all', async () => {
    await start(flagdConfig);
    const effective = { ...HOSTILE_ENV, ...only() };
    for (const [key, value] of Object.entries(HOSTILE_ENV)) {
      expect(effective[key], key).not.toEqual(value);
    }
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
