import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkStart, type StartCheck } from '../src/server/boot.ts';

const check = vi.fn<StartCheck['checkConfig']>();
const exit = vi.fn<StartCheck['exit']>();
const log = vi.fn<StartCheck['log']>();

const run = (over: Partial<StartCheck> = {}) => {
  checkStart({
    runtime: 'nodejs',
    production: true,
    wrapperRunning: true,
    env: {},
    checkConfig: check,
    exit,
    log,
    ...over,
  });
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the start check', () => {
  it('passes a good production start behind the wrapper', () => {
    run();
    expect(exit).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('stops a production start without the wrapper', () => {
    run({ wrapperRunning: false });
    expect(exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledWith('dashboard.wrapper_missing', {});
  });

  it('leaves next dev alone', () => {
    run({ production: false, wrapperRunning: false });
    expect(exit).not.toHaveBeenCalled();
  });

  it('skips the edge runtime', () => {
    run({ runtime: 'edge', wrapperRunning: false });
    expect(exit).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it('stops on a bad config, naming the code and never the message', () => {
    check.mockImplementation(() => {
      throw Object.assign(new Error('value hunter2'), { code: 'AUTH_CONFIG_INVALID', key: 'X' });
    });
    run();
    expect(exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledWith('dashboard.config_invalid', {
      code: 'AUTH_CONFIG_INVALID',
      key: 'X',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('hunter2');
  });

  it('names the key of a database config error, which carries it in the message', () => {
    check.mockImplementation(() => {
      throw Object.assign(new Error('DREFYN_DATABASE_URL is missing'), {
        code: 'DB_CONFIG_INVALID',
      });
    });
    run();
    expect(log).toHaveBeenCalledWith('dashboard.config_invalid', {
      code: 'DB_CONFIG_INVALID',
      key: 'DREFYN_DATABASE_URL',
    });
  });

  it('treats an error with no code as unknown', () => {
    check.mockImplementation(() => {
      throw new Error('secret');
    });
    run();
    expect(log).toHaveBeenCalledWith('dashboard.config_invalid', { code: 'unknown' });
  });
});
