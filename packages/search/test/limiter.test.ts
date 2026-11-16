import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { clientBucket, createMemoryRateLimiter, createRateKeys } from '../src/limiter.ts';
import { TENANT_A, TENANT_B } from './support.ts';

describe('createMemoryRateLimiter', () => {
  it('allows 30 a minute by default, then says when to come back', async () => {
    let now = 1_000_000;
    const limiter = createMemoryRateLimiter({ now: () => now });
    for (let i = 0; i < 30; i += 1) expect(await limiter.take('k')).toEqual({ ok: true });
    expect(await limiter.take('k')).toEqual({ ok: false, retryAfterSeconds: 60 });
    now += 59_001;
    expect(await limiter.take('k')).toEqual({ ok: false, retryAfterSeconds: 1 });
    now += 999;
    expect(await limiter.take('k')).toEqual({ ok: true });
  });

  it('counts each key on its own', async () => {
    const limiter = createMemoryRateLimiter({ limit: 1, now: () => 0 });
    expect(await limiter.take('a')).toEqual({ ok: true });
    expect(await limiter.take('b')).toEqual({ ok: true });
    expect((await limiter.take('a')).ok).toBe(false);
  });

  it('holds no more than maxKeys windows, dropping the oldest', async () => {
    const limiter = createMemoryRateLimiter({ limit: 1, maxKeys: 2, now: () => 0 });
    await limiter.take('a');
    await limiter.take('b');
    await limiter.take('c');
    // 'a' was dropped, so it starts a fresh window; 'c' is still held.
    expect(await limiter.take('a')).toEqual({ ok: true });
    expect((await limiter.take('a')).ok).toBe(false);
  });

  it('never lets more than the limit through in one window, for any sequence', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.constantFrom('a', 'b', 'c'), fc.integer({ min: 0, max: 5000 })), {
          maxLength: 200,
        }),
        async (steps) => {
          let now = 0;
          const limiter = createMemoryRateLimiter({ limit: 5, windowMs: 10_000, now: () => now });
          const allowed = new Map<string, number[]>();
          for (const [key, gap] of steps) {
            now += gap;
            const decision = await limiter.take(key);
            if (decision.ok) allowed.set(key, [...(allowed.get(key) ?? []), now]);
            else expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(1);
          }
          for (const times of allowed.values()) {
            for (const t of times) {
              expect(times.filter((u) => u >= t && u < t + 10_000).length).toBeLessThanOrEqual(5);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('refuses bad options', () => {
    expect(() => createMemoryRateLimiter({ limit: 0 })).toThrow(RangeError);
    expect(() => createMemoryRateLimiter({ windowMs: 1.5 })).toThrow(RangeError);
    expect(() => createMemoryRateLimiter({ maxKeys: -1 })).toThrow(RangeError);
  });
});

describe('clientBucket', () => {
  it.each([
    ['203.0.113.9', '203.0.113.9'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:DB8:0001:0002::7', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['::ffff:198.51.100.7', '198.51.100.7'],
  ])('counts %s as %s', (ip, bucket) => {
    expect(clientBucket(ip)).toBe(bucket);
  });

  it.each([
    '',
    'localhost',
    '1.2.3',
    '01.2.3.4',
    '256.1.1.1',
    '2001:db8::1::2',
    '[::1]',
    'fe80::1%eth0',
    ':',
  ])('refuses %s', (ip) => {
    expect(clientBucket(ip)).toBeNull();
  });

  it('puts every address of one /64 in one bucket', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 0xffff }), { minLength: 4, maxLength: 4 }),
        (host) => {
          const ip = `2001:db8:aa:bb:${host.map((n) => n.toString(16)).join(':')}`;
          expect(clientBucket(ip)).toBe('2001:db8:aa:bb::/64');
        },
      ),
    );
  });
});

describe('createRateKeys', () => {
  it('keys by site and client, and never holds the address', () => {
    const keyOf = createRateKeys(new Uint8Array(32));
    const a = keyOf(TENANT_A, '203.0.113.9');
    expect(a).not.toBeNull();
    expect(a).not.toContain('203.0.113.9');
    expect(keyOf(TENANT_A, '203.0.113.9')).toBe(a);
    expect(keyOf(TENANT_B, '203.0.113.9')).not.toBe(a);
    expect(keyOf(TENANT_A, '203.0.113.10')).not.toBe(a);
    expect(keyOf(TENANT_A, 'nonsense')).toBeNull();
  });

  it('uses a fresh secret per process when none is given', () => {
    expect(createRateKeys()(TENANT_A, '203.0.113.9')).not.toBe(
      createRateKeys()(TENANT_A, '203.0.113.9'),
    );
  });
});
