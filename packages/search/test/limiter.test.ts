import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { clientBucket, createMemoryRateLimiter, createRateKeys } from '../src/limiter.ts';
import { TENANT_A, TENANT_B } from './support.ts';

const LIMIT = 5;
const WINDOW_MS = 10_000;

// Counterexamples the merge queue found against a sliding bound: each lets six through in one
// window length, five in one fixed window and the rest just after it rolls over.
const BOUNDARY_BURSTS: [string, number][][] = [
  [
    ['c', 0],
    ['c', 1211],
    ['c', 2900],
    ['c', 765],
    ['a', 922],
    ['c', 1815],
    ['c', 2387],
    ['c', 0],
  ],
  [
    ['c', 0],
    ['a', 486],
    ['c', 4094],
    ['c', 222],
    ['a', 3],
    ['c', 9],
    ['c', 1902],
    ['c', 3284],
    ['c', 0],
  ],
  [
    ['a', 0],
    ['a', 3830],
    ['a', 913],
    ['a', 1337],
    ['a', 1910],
    ['a', 409],
    ['a', 1601],
    ['a', 0],
  ],
];

// What a fixed window promises: at most the limit per window the limiter opens, refusal
// exactly when that window is full, Retry-After at its end, and so at most twice the limit
// in any span of one window length.
function fixedWindowProperty() {
  const limit = LIMIT;
  const windowMs = WINDOW_MS;
  return fc.asyncProperty(
    fc.array(fc.tuple(fc.constantFrom('a', 'b', 'c'), fc.integer({ min: 0, max: 5000 })), {
      maxLength: 200,
    }),
    async (steps) => {
      let now = 0;
      const limiter = createMemoryRateLimiter({ limit, windowMs, now: () => now });
      // A window opens at the first take after the last one ran out, allowed or not.
      const opened = new Map<string, number>();
      const allowed = new Map<string, { at: number; window: number }[]>();
      for (const [key, gap] of steps) {
        now += gap;
        const start = opened.get(key);
        const window = start === undefined || now - start >= windowMs ? now : start;
        opened.set(key, window);
        const sofar = (allowed.get(key) ?? []).filter((u) => u.window === window).length;
        const decision = await limiter.take(key);
        // Refused exactly when the window is full, and told to come back when it ends.
        expect(decision.ok).toBe(sofar < limit);
        if (decision.ok) allowed.set(key, [...(allowed.get(key) ?? []), { at: now, window }]);
        else {
          expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(1);
          expect(decision.retryAfterSeconds).toBe(Math.ceil((window + windowMs - now) / 1000));
        }
      }
      for (const takes of allowed.values()) {
        for (const { at, window } of takes) {
          expect(takes.filter((u) => u.window === window).length).toBeLessThanOrEqual(limit);
          const span = takes.filter((u) => u.at >= at && u.at < at + windowMs);
          expect(span.length).toBeLessThanOrEqual(2 * limit);
        }
      }
    },
  );
}

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

  // Found by seed -512014843 in the merge queue. Fixed windows let up to twice the limit
  // through across a boundary: five at 0 to 7613, then two more at 10000 in a fresh window,
  // so the span from 1211 holds six. That is the promise, not a leak.
  it('lets a burst through at a window boundary, never more than the limit per window', async () => {
    let now = 0;
    const limiter = createMemoryRateLimiter({ limit: 5, windowMs: 10_000, now: () => now });
    const steps = BOUNDARY_BURSTS[0] ?? [];
    const seen: [string, number, boolean][] = [];
    for (const [key, gap] of steps) {
      now += gap;
      seen.push([key, now, (await limiter.take(key)).ok]);
    }
    expect(seen).toEqual([
      ['c', 0, true],
      ['c', 1211, true],
      ['c', 4111, true],
      ['c', 4876, true],
      ['a', 5798, true],
      ['c', 7613, true],
      ['c', 10_000, true],
      ['c', 10_000, true],
    ]);
    expect((await limiter.take('c')).ok).toBe(true);
    expect((await limiter.take('c')).ok).toBe(true);
    expect((await limiter.take('c')).ok).toBe(true);
    expect(await limiter.take('c')).toEqual({ ok: false, retryAfterSeconds: 10 });
  });

  it('never lets more than the limit through in one window, for any sequence', async () => {
    await fc.assert(fixedWindowProperty(), {
      numRuns: 200,
      examples: BOUNDARY_BURSTS.map((steps) => [steps]),
    });
  });

  it.each(BOUNDARY_BURSTS.map((steps, i) => [i, steps] as const))(
    'pinned burst %i puts six through in one window length',
    async (_, steps) => {
      let now = 0;
      const limiter = createMemoryRateLimiter({
        limit: LIMIT,
        windowMs: WINDOW_MS,
        now: () => now,
      });
      const allowed = new Map<string, number[]>();
      for (const [key, gap] of steps) {
        now += gap;
        if ((await limiter.take(key)).ok) allowed.set(key, [...(allowed.get(key) ?? []), now]);
      }
      const widest = Math.max(
        ...[...allowed.values()].flatMap((times) =>
          times.map((t) => times.filter((u) => u >= t && u < t + WINDOW_MS).length),
        ),
      );
      expect(widest).toBe(LIMIT + 1);
    },
  );

  // Each of these seeds turned a gate red under the old sliding bound.
  it.each([-512014843, 1375364650, -1827718576])('holds for seed %i', async (seed) => {
    await fc.assert(fixedWindowProperty(), { numRuns: 200, seed });
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
