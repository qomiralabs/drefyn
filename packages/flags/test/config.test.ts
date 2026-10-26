import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EVAL_TIMEOUT_MS,
  DEFAULT_FLAGD_SYNC_PORT,
  DEFAULT_FLAGS_FILE,
  DEFAULT_INIT_TIMEOUT_MS,
  FlagError,
  loadFlagConfig,
  type FlagConfigKey,
  type FlagEnv,
} from '../src/index.ts';

function refusal(env: FlagEnv): FlagError {
  try {
    loadFlagConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(FlagError);
    return error as FlagError;
  }
  throw new Error(`expected ${JSON.stringify(env)} to be refused`);
}

function expectInvalid(key: FlagConfigKey, env: FlagEnv, rejected: string) {
  const error = refusal(env);
  expect(error.code).toBe('FLAG_CONFIG_INVALID');
  expect(error.key).toBe(key);
  // Config values can hold hosts and paths; the message names the key, not the value.
  if (rejected.trim().length > 2) expect(error.message).not.toContain(rejected);
}

describe('defaults', () => {
  it('match the documented values', () => {
    expect(DEFAULT_FLAGS_FILE).toBe('/etc/drefyn/flags.json');
    expect(DEFAULT_FLAGD_SYNC_PORT).toBe(8015);
    expect(DEFAULT_EVAL_TIMEOUT_MS).toBe(50);
    expect(DEFAULT_INIT_TIMEOUT_MS).toBe(2000);
  });

  it('an empty environment gives offline file mode', () => {
    expect(loadFlagConfig({})).toEqual({
      source: 'file',
      file: '/etc/drefyn/flags.json',
      evalTimeoutMs: 50,
      initTimeoutMs: 2000,
    });
  });

  it('treats an empty value as unset, the way compose passes an unset variable', () => {
    expect(
      loadFlagConfig({
        DREFYN_FLAGS_SOURCE: '',
        DREFYN_FLAGS_FILE: '',
        DREFYN_FLAGS_EVAL_TIMEOUT_MS: '',
        DREFYN_FLAGS_INIT_TIMEOUT_MS: '',
      }),
    ).toEqual(loadFlagConfig({}));
  });
});

describe('file source', () => {
  it('reads the file path', () => {
    expect(
      loadFlagConfig({ DREFYN_FLAGS_SOURCE: 'file', DREFYN_FLAGS_FILE: '/srv/flags/prod.json' }),
    ).toEqual({
      source: 'file',
      file: '/srv/flags/prod.json',
      evalTimeoutMs: 50,
      initTimeoutMs: 2000,
    });
  });

  it('reads both timeouts', () => {
    expect(
      loadFlagConfig({ DREFYN_FLAGS_EVAL_TIMEOUT_MS: '20', DREFYN_FLAGS_INIT_TIMEOUT_MS: '500' }),
    ).toMatchObject({ evalTimeoutMs: 20, initTimeoutMs: 500 });
  });
});

describe('flagd source', () => {
  it('reads host and sync port', () => {
    expect(
      loadFlagConfig({
        DREFYN_FLAGS_SOURCE: 'flagd',
        DREFYN_FLAGD_HOST: 'flagd.internal',
        DREFYN_FLAGD_SYNC_PORT: '9015',
      }),
    ).toEqual({
      source: 'flagd',
      host: 'flagd.internal',
      syncPort: 9015,
      evalTimeoutMs: 50,
      initTimeoutMs: 2000,
    });
  });

  it('defaults the sync port to 8015', () => {
    expect(
      loadFlagConfig({ DREFYN_FLAGS_SOURCE: 'flagd', DREFYN_FLAGD_HOST: '10.0.0.5' }),
    ).toMatchObject({ syncPort: 8015 });
  });

  it.each(['1', '65535'])('accepts port %s', (port) => {
    expect(
      loadFlagConfig({
        DREFYN_FLAGS_SOURCE: 'flagd',
        DREFYN_FLAGD_HOST: 'h',
        DREFYN_FLAGD_SYNC_PORT: port,
      }),
    ).toMatchObject({ syncPort: Number(port) });
  });

  it('never carries a resolver choice, whatever else is in the environment', () => {
    const config = loadFlagConfig({
      DREFYN_FLAGS_SOURCE: 'flagd',
      DREFYN_FLAGD_HOST: 'h',
      FLAGD_RESOLVER: 'rpc',
      DREFYN_FLAGS_RESOLVER: 'rpc',
    });
    expect(Object.keys(config).sort()).toEqual(
      ['evalTimeoutMs', 'host', 'initTimeoutMs', 'source', 'syncPort'].sort(),
    );
  });
});

describe('FLAG_CONFIG_INVALID', () => {
  it.each(['rpc', 'in-process', 'FILE', 'Flagd', ' file', 'file ', 'unleash', 's3'])(
    'source %j',
    (source) => {
      expectInvalid('DREFYN_FLAGS_SOURCE', { DREFYN_FLAGS_SOURCE: source }, source);
    },
  );

  it('flagd without a host', () => {
    expectInvalid('DREFYN_FLAGD_HOST', { DREFYN_FLAGS_SOURCE: 'flagd' }, '');
    expectInvalid('DREFYN_FLAGD_HOST', { DREFYN_FLAGS_SOURCE: 'flagd', DREFYN_FLAGD_HOST: '' }, '');
    expectInvalid(
      'DREFYN_FLAGD_HOST',
      { DREFYN_FLAGS_SOURCE: 'flagd', DREFYN_FLAGD_HOST: '  ' },
      '',
    );
  });

  it.each(['0', '65536', '-1', '80.5', 'abc', '1e3', '0x1f', ' 8015', '8015 ', 'NaN', 'Infinity'])(
    'sync port %j',
    (port) => {
      expectInvalid(
        'DREFYN_FLAGD_SYNC_PORT',
        { DREFYN_FLAGS_SOURCE: 'flagd', DREFYN_FLAGD_HOST: 'h', DREFYN_FLAGD_SYNC_PORT: port },
        port,
      );
    },
  );

  it('a bad sync port even when the source is file, so a typo never waits for a switch', () => {
    expectInvalid('DREFYN_FLAGD_SYNC_PORT', { DREFYN_FLAGD_SYNC_PORT: 'abc' }, 'abc');
  });

  it.each(['0', '-1', '1.5', 'abc', 'Infinity', 'NaN', '1e2', ' 50', '9007199254740993'])(
    'eval timeout %j',
    (value) => {
      expectInvalid('DREFYN_FLAGS_EVAL_TIMEOUT_MS', { DREFYN_FLAGS_EVAL_TIMEOUT_MS: value }, value);
    },
  );

  it.each(['-1', '2.5', 'abc', 'Infinity', 'NaN', ' 2000'])('init timeout %j', (value) => {
    expectInvalid('DREFYN_FLAGS_INIT_TIMEOUT_MS', { DREFYN_FLAGS_INIT_TIMEOUT_MS: value }, value);
  });

  it('does not echo a host that could carry credentials', () => {
    expectInvalid(
      'DREFYN_FLAGD_SYNC_PORT',
      {
        DREFYN_FLAGS_SOURCE: 'flagd',
        DREFYN_FLAGD_HOST: 'user:secret@flagd',
        DREFYN_FLAGD_SYNC_PORT: 'x',
      },
      'user:secret@flagd',
    );
  });
});

describe('the production config ignores DREFYN_RELEASE_FLAGS', () => {
  it.each(['on', 'off', 'garbage'])('%j changes nothing and is not an error', (value) => {
    expect(loadFlagConfig({ DREFYN_RELEASE_FLAGS: value })).toEqual(loadFlagConfig({}));
  });
});
