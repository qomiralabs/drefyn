import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { checkDashboardConfig } from '../src/server/auth.ts';
import { checkStart } from '../src/server/boot.ts';

const ENV = {
  DREFYN_APP_ORIGIN: 'https://app.drefyn.test',
  DREFYN_AUTH_SECRET: randomBytes(32).toString('base64url'),
  DREFYN_AUTH_INVITATION_BLOCK_KEY: randomBytes(32).toString('base64url'),
  DREFYN_DATABASE_URL: 'postgres://app:app@127.0.0.1:1/drefyn',
  DREFYN_AUTH_DATABASE_URL: 'postgres://auth:auth@127.0.0.1:1/drefyn',
  DREFYN_DATABASE_SSL: 'disable',
  DREFYN_DATABASE_POOL_MAX: '6',
  UV_THREADPOOL_SIZE: '16',
};

const start = (env: Record<string, string>) => {
  const exit = vi.fn<(code: number) => void>();
  const log = vi.fn<(event: string, context: Record<string, string>) => void>();
  checkStart({
    runtime: 'nodejs',
    production: true,
    wrapperRunning: true,
    env,
    checkConfig: checkDashboardConfig,
    exit,
    log,
  });
  return { exit, log };
};

describe('the engine config at start', () => {
  it('starts with a ceiling below the pool', () => {
    const { exit, log } = start({ ...ENV, DREFYN_ENGINE_POOL_CEILING: '5' });
    expect(log).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('stops a ceiling equal to the pool, naming the key and no value', () => {
    const { exit, log } = start({ ...ENV, DREFYN_ENGINE_POOL_CEILING: '6' });
    expect(exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledWith('dashboard.config_invalid', {
      code: 'ENGINE_CONFIG_INVALID',
      key: 'DREFYN_ENGINE_POOL_CEILING',
    });
  });

  it('stops an unreadable engine key', () => {
    const { exit, log } = start({ ...ENV, DREFYN_ENGINE_QUERY_MAX_IN_FLIGHT: 'many' });
    expect(exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledWith('dashboard.config_invalid', {
      code: 'ENGINE_CONFIG_INVALID',
      key: 'DREFYN_ENGINE_QUERY_MAX_IN_FLIGHT',
    });
  });
});
