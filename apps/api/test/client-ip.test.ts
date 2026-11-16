import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseIp, resolveClientAddress } from '../src/client-ip.ts';

const SOCKET = '10.0.0.2';
const none = { hops: 0, viewerHeader: false };
const one = { hops: 1, viewerHeader: false };
const viewer = { hops: 1, viewerHeader: true };

const runs = { seed: 365, numRuns: 300 } as const;
const anyHeader = fc.option(fc.string({ maxLength: 80 }), { nil: undefined });

describe('resolveClientAddress', () => {
  it('uses the socket with no hops, whatever the client sends', () => {
    fc.assert(
      fc.property(anyHeader, anyHeader, (forwardedFor, viewerValue) => {
        expect(
          resolveClientAddress({ socket: SOCKET, forwardedFor, viewer: viewerValue }, none),
        ).toEqual({ address: SOCKET, chainInvalid: false });
      }),
      runs,
    );
  });

  // Whatever a client puts to the left, one trusted hop reads only the entry it appended.
  it('takes the entry the trusted hop wrote and ignores what the client prepended', () => {
    fc.assert(
      fc.property(fc.array(fc.ipV4(), { maxLength: 5 }), fc.ipV4(), (spoofed, real) => {
        const forwardedFor = [...spoofed, real].join(', ');
        expect(
          resolveClientAddress({ socket: SOCKET, forwardedFor, viewer: undefined }, one),
        ).toEqual({ address: real, chainInvalid: false });
      }),
      runs,
    );
  });

  it('falls back to the left most trusted entry on a short chain', () => {
    expect(
      resolveClientAddress({ socket: SOCKET, forwardedFor: undefined, viewer: undefined }, one),
    ).toEqual({ address: SOCKET, chainInvalid: true });
    expect(
      resolveClientAddress(
        { socket: SOCKET, forwardedFor: '203.0.113.9', viewer: undefined },
        { hops: 3, viewerHeader: false },
      ),
    ).toEqual({ address: '203.0.113.9', chainInvalid: true });
  });

  it('falls back when a trusted entry does not parse', () => {
    expect(
      resolveClientAddress(
        { socket: SOCKET, forwardedFor: '203.0.113.9, garbage', viewer: undefined },
        { hops: 2, viewerHeader: false },
      ),
    ).toEqual({ address: SOCKET, chainInvalid: true });
    expect(
      resolveClientAddress({ socket: SOCKET, forwardedFor: 'garbage', viewer: undefined }, one),
    ).toEqual({ address: SOCKET, chainInvalid: true });
  });

  it('reads the viewer header from the trusted hop when configured', () => {
    expect(
      resolveClientAddress(
        { socket: SOCKET, forwardedFor: '198.51.100.1', viewer: '2001:db8::1:443' },
        viewer,
      ),
    ).toEqual({ address: '2001:db8::1', chainInvalid: false });
    expect(
      resolveClientAddress(
        { socket: SOCKET, forwardedFor: '198.51.100.1', viewer: '203.0.113.7:51234' },
        viewer,
      ),
    ).toEqual({ address: '203.0.113.7', chainInvalid: false });
  });

  it('flags a missing or garbled viewer header and uses the chain', () => {
    for (const value of [undefined, 'nonsense', '203.0.113.7', ':80']) {
      expect(
        resolveClientAddress(
          { socket: SOCKET, forwardedFor: '198.51.100.1', viewer: value },
          viewer,
        ),
      ).toEqual({ address: '198.51.100.1', chainInvalid: true });
    }
  });
});

describe('parseIp', () => {
  it.each(['203.0.113.9', '::1', '2001:db8::1', '::ffff:192.0.2.1', '1:2:3:4:5:6:7:8', '::'])(
    'takes %s',
    (text) => {
      expect(parseIp(text)).toBe(text);
    },
  );

  it.each([
    '01.2.3.4',
    '256.1.1.1',
    '[::1]',
    'fe80::1%eth0',
    '1:2:3:4:5:6:7:8:9',
    '1::2::3',
    '1:2:3:4:5:6:7::8',
    '::ffff:999.0.0.1',
    'g::1',
    '',
  ])('refuses %s', (text) => {
    expect(parseIp(text)).toBeNull();
  });
});
