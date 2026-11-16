import type * as DbModule from '@drefyn/db';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { AuthError } from '@drefyn/auth';
import { DbError, type Database, type PublishedDatabase } from '@drefyn/db';
import { FlagError, loadFlagConfig, type FlagClient } from '@drefyn/flags';
import { organizationId } from '@drefyn/tenancy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiConfigError } from '../src/config.ts';
import {
  describeStartFailure,
  lazyFlagClient,
  startApi,
  stopOnSignals,
  type RunningApi,
  type StartOptions,
} from '../src/start.ts';
import type { LogLine } from './support.ts';

const closed: unknown[] = [];

vi.mock('@drefyn/db', async (original) => {
  const actual = await original<typeof DbModule>();
  return {
    ...actual,
    closeDatabase: (db: unknown) => {
      closed.push(db);
      return Promise.resolve();
    },
  };
});

const ENV = {
  DREFYN_API_RATE_LIMIT_KEY: randomBytes(32).toString('base64url'),
  DREFYN_API_PORT: '0',
};

const running: RunningApi[] = [];
afterEach(async () => {
  for (const api of running.splice(0)) await api.stop();
  closed.length = 0;
});

function seams(over: Partial<StartOptions> = {}) {
  const logs: LogLine[] = [];
  const db = Object.freeze({ app: true }) as unknown as Database;
  const published = Object.freeze({ reader: true }) as unknown as PublishedDatabase;
  const flagsClosed = vi.fn(() => Promise.resolve());
  const opened: string[] = [];
  const options: StartOptions = {
    logger: {
      info: (event, fields = {}) => logs.push({ level: 'info', event, fields }),
      warn: (event, fields = {}) => logs.push({ level: 'warn', event, fields }),
      error: (event, fields = {}) => logs.push({ level: 'error', event, fields }),
    },
    openDatabase: () => {
      opened.push('app');
      return Promise.resolve(db);
    },
    openPublished: () => {
      opened.push('reader');
      return Promise.resolve(published);
    },
    flags: {
      isOn: () => Promise.resolve(false),
      evaluate: () => Promise.reject(new Error('not used')),
      close: flagsClosed,
    },
    ...over,
  };
  return { options, logs, db, published, flagsClosed, opened };
}

async function start(env: Record<string, string>, options: StartOptions) {
  const api = await startApi(env, options);
  running.push(api);
  return api;
}

const url = (api: RunningApi, path: string) => `http://127.0.0.1:${String(api.port)}${path}`;

function deferred() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

describe('startApi', () => {
  it.each([
    ['DREFYN_AUTH_DATABASE_URL', 'postgres://drefyn_auth:pw@127.0.0.1:1/drefyn'],
    ['DREFYN_AUTH_SECRET', randomBytes(32).toString('base64url')],
  ])('refuses %s before opening any pool', async (key, value) => {
    const { options, opened } = seams();
    await expect(startApi({ ...ENV, [key]: value }, options)).rejects.toMatchObject({
      code: 'AUTH_CONFIG_INVALID',
      key,
    });
    expect(opened).toEqual([]);
  });

  it('refuses a bad flag setting before opening any pool', async () => {
    const { options, opened } = seams();
    await expect(
      startApi({ ...ENV, DREFYN_FLAGS_SOURCE: 'remote' }, options),
    ).rejects.toBeInstanceOf(FlagError);
    expect(opened).toEqual([]);
  });

  it('serves health on the chosen port and says where it listens', async () => {
    const { options, logs } = seams();
    const api = await start(ENV, options);
    const response = await fetch(url(api, '/healthz'));
    expect(response.status).toBe(200);
    expect(logs).toContainEqual({
      level: 'info',
      event: 'api.listening',
      fields: { port: api.port },
    });
  });

  it('closes the app pool when the reader pool cannot open', async () => {
    const { options, db } = seams({
      openPublished: () => Promise.reject(new DbError('DB_UNAVAILABLE', 'reader down')),
    });
    await expect(startApi(ENV, options)).rejects.toMatchObject({ code: 'DB_UNAVAILABLE' });
    expect(closed).toEqual([db]);
  });

  it('closes both pools and the flags when the port is taken', async () => {
    const first = await start(ENV, seams().options);
    const { options, db, published, flagsClosed } = seams();
    await expect(
      startApi({ ...ENV, DREFYN_API_PORT: String(first.port) }, options),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(closed).toEqual([db, published]);
    expect(flagsClosed).toHaveBeenCalledTimes(1);
  });

  it('lets a request in flight finish on stop, refuses new ones, then closes the pools', async () => {
    const { gate, release } = deferred();
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { options, db, published, flagsClosed, logs } = seams({
      mount: (app) => {
        app.get('/v1/slow', async (c) => {
          entered();
          await gate;
          return c.json({ finished: true });
        });
      },
    });
    const api = await start(ENV, options);
    const slow = fetch(url(api, '/v1/slow'));
    await inside;
    const stopped = api.stop();
    // The same promise however often stop is called.
    expect(api.stop()).toBe(stopped);
    await expect(fetch(url(api, '/healthz'))).rejects.toThrow();
    release();
    const response = await slow;
    expect(await response.json()).toEqual({ finished: true });
    await stopped;
    expect(closed).toEqual([db, published]);
    expect(flagsClosed).toHaveBeenCalledTimes(1);
    const events = logs.map((l) => l.event);
    expect(events.indexOf('api.stopping')).toBeLessThan(events.indexOf('api.stopped'));
  });

  it('cuts what is still open after the drain time', async () => {
    const never = new Promise<never>(() => undefined);
    const { options, db, published } = seams({
      drainMs: 50,
      mount: (app) => {
        app.get('/v1/stuck', async () => never);
      },
    });
    const api = await start(ENV, options);
    const stuck = fetch(url(api, '/v1/stuck')).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await api.stop();
    expect(await stuck).toBeInstanceOf(Error);
    expect(closed).toEqual([db, published]);
  });
});

describe('stopOnSignals', () => {
  it.each(['SIGTERM', 'SIGINT'])('drains on %s, then exits 0', async (signal) => {
    const target = new EventEmitter();
    const stop = vi.fn(() => Promise.resolve());
    const exited = new Promise<number>((resolve) => {
      stopOnSignals({ port: 0, stop }, resolve, target);
    });
    target.emit(signal);
    expect(await exited).toBe(0);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('describeStartFailure', () => {
  it('gives the kind, code and key of the errors it knows', () => {
    expect(describeStartFailure(new ApiConfigError('DREFYN_API_PORT', 'must be a port'))).toEqual({
      error: 'ApiConfigError',
      key: 'DREFYN_API_PORT',
      reason: 'DREFYN_API_PORT must be a port',
    });
    expect(
      describeStartFailure(new AuthError('AUTH_CONFIG_INVALID', { key: 'DREFYN_AUTH_SECRET' })),
    ).toEqual({ error: 'AuthError', code: 'AUTH_CONFIG_INVALID', key: 'DREFYN_AUTH_SECRET' });
    expect(describeStartFailure(new AuthError('AUTH_UNAVAILABLE'))).toEqual({
      error: 'AuthError',
      code: 'AUTH_UNAVAILABLE',
    });
    expect(describeStartFailure(new DbError('DB_UNAVAILABLE', 'no answer'))).toEqual({
      error: 'DbError',
      code: 'DB_UNAVAILABLE',
      reason: 'no answer',
    });
    expect(
      describeStartFailure(new FlagError('FLAG_CONFIG_INVALID', { key: 'DREFYN_FLAGS_SOURCE' })),
    ).toEqual({ error: 'FlagError', code: 'FLAG_CONFIG_INVALID', key: 'DREFYN_FLAGS_SOURCE' });
    expect(describeStartFailure(new FlagError('FLAG_DEFINITION_INVALID'))).toEqual({
      error: 'FlagError',
      code: 'FLAG_DEFINITION_INVALID',
    });
  });

  it('gives only the name of anything else', () => {
    expect(describeStartFailure(new TypeError('secret value inside'))).toEqual({
      error: 'TypeError',
    });
    expect(describeStartFailure('text')).toEqual({ error: 'string' });
  });
});

describe('lazyFlagClient', () => {
  const ORG = organizationId('01900000-0000-7000-8000-000000000a01');
  const fileConfig = (file: string) =>
    loadFlagConfig({ DREFYN_FLAGS_FILE: file, DREFYN_FLAGS_INIT_TIMEOUT_MS: '2000' });
  const ON = join(import.meta.dirname, '..', '..', 'dashboard', 'e2e', 'flags', 'on.json');

  it('starts the client on first use and closes it', async () => {
    const { options } = seams();
    const client: FlagClient = lazyFlagClient(fileConfig(ON), options.logger ?? never());
    expect(await client.isOn('dashboard.shell', { organizationId: ORG })).toBe(true);
    expect((await client.evaluate('dashboard.shell', { organizationId: ORG })).value).toBe(true);
    await client.close();
  });

  it('answers the safe value when the flag file is missing', async () => {
    const { options } = seams();
    const missing = join(import.meta.dirname, 'no-such-flags.json');
    const client = lazyFlagClient(
      loadFlagConfig({ DREFYN_FLAGS_FILE: missing, DREFYN_FLAGS_INIT_TIMEOUT_MS: '200' }),
      options.logger ?? never(),
    );
    expect(await client.isOn('dashboard.shell', { organizationId: ORG })).toBe(false);
    await client.close();
  });

  it('closes cleanly when it was never used', async () => {
    const { options } = seams();
    await expect(
      lazyFlagClient(fileConfig(ON), options.logger ?? never()).close(),
    ).resolves.toBeUndefined();
  });
});

function never(): never {
  throw new Error('no logger');
}
