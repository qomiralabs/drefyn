import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { clientIpWrapperRunning, markClientIpWrapper } from '../src/server/wrapper-marker.ts';

describe('the client IP wrapper marker', () => {
  it('starts absent, sets once and cannot be cleared', () => {
    expect(clientIpWrapperRunning()).toBe(false);
    markClientIpWrapper();
    expect(clientIpWrapperRunning()).toBe(true);
    markClientIpWrapper();
    const key = Symbol.for('drefyn.client_ip_wrapper');
    expect(Object.getOwnPropertyDescriptor(globalThis, key)).toMatchObject({
      value: true,
      writable: false,
      configurable: false,
    });
  });

  it('is called only by the server entry', () => {
    const pattern = ['markClient', 'IpWrapper('].join('');
    const hits = execFileSync('git', ['grep', '-lF', pattern, '--', '.'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line !== '');
    const callers = hits.filter(
      (path) => path !== 'src/server/wrapper-marker.ts' && path !== 'test/wrapper-marker.test.ts',
    );
    expect(callers.filter((path) => path !== 'server.ts')).toEqual([]);
  });
});
