import { describe, expect, it } from 'vitest';
import { parseAuthConfig, type Env } from '../src/index.ts';
import { expectAuthError, validEnv } from './support.ts';

const env = (extra: Env = {}): Env => ({ ...validEnv(), ...extra });
const noArgon2 = { argon2: undefined };

describe('password startup checks', () => {
  it('refuses a runtime without crypto.argon2 and names the cause', () => {
    const error = expectAuthError(
      () => parseAuthConfig(env(), noArgon2),
      'AUTH_CONFIG_INVALID',
      'DREFYN_AUTH_PASSWORDS',
    );
    expect(error.message).toContain('crypto.argon2');
  });

  it('refuses a crypto.argon2 that is not a function', () => {
    expectAuthError(
      () => parseAuthConfig(env(), { argon2: 'argon2' }),
      'AUTH_CONFIG_INVALID',
      'DREFYN_AUTH_PASSWORDS',
    );
  });

  it('starts without crypto.argon2 when passwords are off', () => {
    const config = parseAuthConfig(env({ DREFYN_AUTH_PASSWORDS: 'off' }), noArgon2);
    expect(config.passwords.enabled).toBe(false);
  });

  it('starts on this runtime, which has crypto.argon2', () => {
    expect(parseAuthConfig(env()).passwords.enabled).toBe(true);
  });

  it.each([
    ['DREFYN_AUTH_PASSWORD_ARGON2_MEMORY_KIB', '19455'],
    ['DREFYN_AUTH_PASSWORD_ARGON2_MEMORY_KIB', '1024'],
    ['DREFYN_AUTH_PASSWORD_ARGON2_PASSES', '1'],
    ['DREFYN_AUTH_PASSWORD_ARGON2_PARALLELISM', '0'],
  ] as const)('refuses %s=%s, under the floor', (key, value) => {
    expectAuthError(() => parseAuthConfig(env({ [key]: value })), 'AUTH_CONFIG_INVALID', key);
  });

  it('accepts the floor itself', () => {
    const config = parseAuthConfig(
      env({
        DREFYN_AUTH_PASSWORD_ARGON2_MEMORY_KIB: '19456',
        DREFYN_AUTH_PASSWORD_ARGON2_PASSES: '2',
        DREFYN_AUTH_PASSWORD_ARGON2_PARALLELISM: '1',
      }),
    );
    expect(config.passwords.argon2).toEqual({ memoryKib: 19_456, passes: 2, parallelism: 1 });
  });

  it('refuses a thread pool left at the default of 4, or unset', () => {
    expectAuthError(
      () => parseAuthConfig(env({ UV_THREADPOOL_SIZE: '4' })),
      'AUTH_CONFIG_INVALID',
      'UV_THREADPOOL_SIZE',
    );
    expectAuthError(
      () => parseAuthConfig(env({ UV_THREADPOOL_SIZE: undefined })),
      'AUTH_CONFIG_INVALID',
      'UV_THREADPOOL_SIZE',
    );
  });

  it('refuses a hash concurrency of half the pool or more, and takes one under half', () => {
    expectAuthError(
      () =>
        parseAuthConfig(
          env({ UV_THREADPOOL_SIZE: '16', DREFYN_AUTH_PASSWORD_HASH_CONCURRENCY: '8' }),
        ),
      'AUTH_CONFIG_INVALID',
      'DREFYN_AUTH_PASSWORD_HASH_CONCURRENCY',
    );
    expectAuthError(
      () =>
        parseAuthConfig(
          env({ UV_THREADPOOL_SIZE: '16', DREFYN_AUTH_PASSWORD_HASH_CONCURRENCY: '9' }),
        ),
      'AUTH_CONFIG_INVALID',
      'DREFYN_AUTH_PASSWORD_HASH_CONCURRENCY',
    );
    const config = parseAuthConfig(
      env({ UV_THREADPOOL_SIZE: '16', DREFYN_AUTH_PASSWORD_HASH_CONCURRENCY: '7' }),
    );
    expect(config.passwords.hashConcurrency).toBe(7);
  });

  it('defaults the waiter queue to 64', () => {
    expect(parseAuthConfig(env()).passwords.hashQueueMax).toBe(64);
  });
});
