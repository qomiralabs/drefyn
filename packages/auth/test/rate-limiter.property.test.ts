import type { AuthDatabase, Database, WindowCount } from '@drefyn/db';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  AuthError,
  createApiKeyFailureLimiter,
  createRateLimiter,
  deriveAuthKeys,
  parseAuthConfig,
  type ApiAuthConfig,
} from '../src/index.ts';
import { runs, validEnv } from './support.ts';

const db = {} as AuthDatabase;
const keys = deriveAuthKeys(new Uint8Array(32).fill(3));

// A fixed window store with the same rules as the upsert: one counter per bucket, key and
// window, aligned to the clock, incremented on every reservation.
function memoryStore(clock: { now: number }) {
  const counts = new Map<string, number>();
  return (
    _db: unknown,
    request: { bucket: string; keyHmac: Uint8Array; windowSeconds: readonly number[] },
  ): Promise<readonly WindowCount[]> =>
    Promise.resolve(
      request.windowSeconds.map((windowSeconds) => {
        const start = Math.floor(clock.now / windowSeconds) * windowSeconds;
        const id = `${request.bucket}|${Buffer.from(request.keyHmac).toString('hex')}|${String(windowSeconds)}|${String(start)}`;
        const count = (counts.get(id) ?? 0) + 1;
        counts.set(id, count);
        return {
          windowSeconds,
          count,
          retryAfterSeconds: Math.max(1, start + windowSeconds - clock.now),
        };
      }),
    );
}

const step = fc.record({
  advance: fc.integer({ min: 0, max: 400 }),
  who: fc.constantFrom('a@example.com', 'b@example.com'),
});

it('never lets more than the limit through in any window, over random sequences', async () => {
  const { rateLimits } = parseAuthConfig({
    ...validEnv(),
    DREFYN_AUTH_RATE_EMAIL_SEND: '3/10m,10/1h',
  });
  await fc.assert(
    fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 120 }), async (steps) => {
      const clock = { now: 1_700_000_000 };
      const limiter = createRateLimiter({
        db,
        keys,
        limits: rateLimits,
        reserve: memoryStore(clock),
      });
      const allowed = new Map<string, number>();
      for (const { advance, who } of steps) {
        clock.now += advance;
        let ok = true;
        try {
          await limiter.reserve('email_send', [who]);
        } catch (error) {
          expect(error).toBeInstanceOf(AuthError);
          expect((error as AuthError).retryAfterSeconds).toBeGreaterThanOrEqual(1);
          ok = false;
        }
        if (!ok) continue;
        for (const { count, windowSeconds } of rateLimits.email_send) {
          const id = `${who}|${String(windowSeconds)}|${String(Math.floor(clock.now / windowSeconds))}`;
          const next = (allowed.get(id) ?? 0) + 1;
          allowed.set(id, next);
          expect(next).toBeLessThanOrEqual(count);
        }
      }
    }),
    runs,
  );
});

// Any strict subset of the windows, with counts under every limit, so nothing but the missing
// window can refuse.
const partialAnswer = (windows: readonly number[]) =>
  fc.record({
    kept: fc.subarray([...windows], { maxLength: windows.length - 1 }),
    count: fc.integer({ min: 1, max: 2 }),
  });

const answer = (kept: readonly number[], count: number) => (): Promise<readonly WindowCount[]> =>
  Promise.resolve(kept.map((windowSeconds) => ({ windowSeconds, count, retryAfterSeconds: 9 })));

const refusedAsUnavailable = async (attempt: Promise<void>) => {
  const error = await attempt.then(
    () => 'allowed',
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AuthError);
  expect((error as AuthError).code).toBe('AUTH_UNAVAILABLE');
};

it('never allows a sign in attempt on any subset of its windows', async () => {
  const { rateLimits } = parseAuthConfig({
    ...validEnv(),
    DREFYN_AUTH_RATE_EMAIL_SEND: '3/10m,10/1h,20/1d',
  });
  const windows = rateLimits.email_send.map((l) => l.windowSeconds);
  await fc.assert(
    fc.asyncProperty(partialAnswer(windows), async ({ kept, count }) => {
      const limiter = createRateLimiter({
        db,
        keys,
        limits: rateLimits,
        reserve: answer(kept, count),
      });
      await refusedAsUnavailable(limiter.reserve('email_send', ['a@example.com']));
    }),
    runs,
  );
});

it('never allows an API key failure on any subset of its windows', async () => {
  const limits = [
    { count: 5, windowSeconds: 60 },
    { count: 20, windowSeconds: 3600 },
    { count: 50, windowSeconds: 86_400 },
  ];
  const config = {
    apiKeyFail: limits,
    failureKey: () => Buffer.alloc(32),
  } as unknown as ApiAuthConfig;
  await fc.assert(
    fc.asyncProperty(partialAnswer(limits.map((l) => l.windowSeconds)), async ({ kept, count }) => {
      const limiter = createApiKeyFailureLimiter({
        db: {} as Database,
        config,
        reserve: answer(kept, count),
      });
      await refusedAsUnavailable(limiter.reserve('client'));
    }),
    runs,
  );
});
