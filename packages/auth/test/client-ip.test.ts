import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { rateKeyForIp } from '../src/index.ts';
import { expectAuthError, runs } from './support.ts';

const group = fc.integer({ min: 0, max: 0xffff }).map((n) => n.toString(16));
const groups = (n: number) => fc.array(group, { minLength: n, maxLength: n });

describe('rateKeyForIp', () => {
  it('keys IPv4 by the whole address', () => {
    expect(rateKeyForIp('203.0.113.7')).toBe('ip4:203.0.113.7');
    expect(rateKeyForIp('203.0.113.8')).not.toBe(rateKeyForIp('203.0.113.7'));
  });

  it('keys IPv6 by its /64, in one fixed spelling', () => {
    expect(rateKeyForIp('2001:db8:1:2::1')).toBe('ip6:2001:0db8:0001:0002::/64');
    expect(rateKeyForIp('2001:DB8:1:2:ffff:ffff:ffff:ffff')).toBe('ip6:2001:0db8:0001:0002::/64');
    expect(rateKeyForIp('2001:db8:1:3::1')).toBe('ip6:2001:0db8:0001:0003::/64');
    expect(rateKeyForIp('::1')).toBe('ip6:0000:0000:0000:0000::/64');
    expect(rateKeyForIp('2001:db8::')).toBe('ip6:2001:0db8:0000:0000::/64');
    expect(rateKeyForIp('::')).toBe('ip6:0000:0000:0000:0000::/64');
    expect(rateKeyForIp('1:2:3:4:5:6:7::')).toBe('ip6:0001:0002:0003:0004::/64');
    expect(rateKeyForIp('1:2:3:4:5:6:1.2.3.4')).toBe('ip6:0001:0002:0003:0004::/64');
  });

  it('reads an IPv4 mapped IPv6 address as the IPv4 address it carries', () => {
    expect(rateKeyForIp('::ffff:203.0.113.7')).toBe('ip4:203.0.113.7');
    expect(rateKeyForIp('::ffff:cb00:7107')).toBe('ip4:203.0.113.7');
  });

  it('reads an embedded IPv4 tail without changing the /64', () => {
    expect(rateKeyForIp('2001:db8:1:2::203.0.113.7')).toBe('ip6:2001:0db8:0001:0002::/64');
  });

  it.each([
    '',
    'localhost',
    '203.0.113',
    '203.0.113.256',
    '1.2.3.4.5',
    '::ffff:1.2.3',
    '2001:db8::1::2',
    '2001:db8:1:2:3:4:5:6:7',
    'fe80::1%eth0',
    ' 203.0.113.7',
    '203.0.113.7\n',
    `2001:db8::${'1'.repeat(5)}`,
    '1::2::3',
    ':1:2:3:4:5:6:7',
    '1:2:3:4:5:6:7:',
    '1:2:3:4:5:6:7:8::',
    '::1:2:3:4:5:6:7:8',
    '::ffff:01.2.3.4',
    '010.1.2.3',
    '1:2:3:4:5:6:1.2.3.4:5',
    'a:1.2.3.4',
    '2001:db8::g',
    ':::',
  ])('refuses %j', (ip) => {
    expectAuthError(() => rateKeyForIp(ip), 'AUTH_INPUT_INVALID');
  });

  it('puts two addresses in one /64 in one bucket, and two /64s in two', () => {
    fc.assert(
      fc.property(groups(4), groups(4), groups(4), (prefix, a, b) => {
        const left = rateKeyForIp([...prefix, ...a].join(':'));
        const right = rateKeyForIp([...prefix, ...b].join(':'));
        expect(left).toBe(right);
      }),
      runs,
    );
    fc.assert(
      fc.property(groups(4), groups(4), groups(4), (p, q, tail) => {
        fc.pre(p.map((g) => parseInt(g, 16)).join() !== q.map((g) => parseInt(g, 16)).join());
        expect(rateKeyForIp([...p, ...tail].join(':'))).not.toBe(
          rateKeyForIp([...q, ...tail].join(':')),
        );
      }),
      runs,
    );
  });

  it('gives the same key for every spelling of one address', () => {
    fc.assert(
      fc.property(groups(8), (parts) => {
        const full = parts.map((g) => g.padStart(4, '0')).join(':');
        const short = parts.join(':');
        const upper = short.toUpperCase();
        expect(rateKeyForIp(short)).toBe(rateKeyForIp(full));
        expect(rateKeyForIp(upper)).toBe(rateKeyForIp(full));
      }),
      runs,
    );
  });
});
