import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { userAgentFamily } from '../src/index.ts';
import { runs } from './support.ts';

describe('userAgentFamily', () => {
  it.each([
    ['Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', 'Firefox on Linux'],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      'Chrome on Windows',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
      'Edge on Windows',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15',
      'Safari on macOS',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
      'Safari on iOS',
    ],
    [
      'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
      'Chrome on Android',
    ],
    ['curl/8.9.1', 'Other'],
    ['', 'Other'],
  ])('reads %s as %s', (ua, family) => {
    expect(userAgentFamily(ua)).toBe(family);
  });

  it('only ever returns one of a short closed list, so nothing identifying is stored', () => {
    const browsers = ['Firefox', 'Chrome', 'Edge', 'Safari', 'Opera'];
    const systems = ['Windows', 'macOS', 'Linux', 'iOS', 'Android', 'ChromeOS'];
    const allowed = new Set([
      'Other',
      ...browsers.flatMap((b) => [b, ...systems.map((s) => `${b} on ${s}`)]),
    ]);
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (ua) => {
        expect(allowed.has(userAgentFamily(ua))).toBe(true);
      }),
      runs,
    );
  });
});
