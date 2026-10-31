import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  reserveApiKeyFailureWindows,
  reserveAuthRateWindows,
  withApiKeyLimiter,
  withAuth,
  type WindowCount,
  type AuthDatabase,
  type Database,
} from '../../src/index.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { superuser } from './support/stack.ts';
import { authUrl, pools } from './support/tenancy.ts';

const dbs = databases();
const open = pools();

const key = (label: string) => createHash('sha256').update(label).digest();
// Enough connections that 200 reservations queue briefly rather than time out.
const POOL = { DREFYN_DATABASE_POOL_MAX: '10', DREFYN_DATABASE_POOL_WAIT_MS: '10000' };

let db: TestDatabase;
let auth: AuthDatabase;
let app: Database;

describeWithStack('rate limit windows', () => {
  beforeAll(async () => {
    db = await dbs.fresh('migrated');
    auth = await open.auth(authUrl(db), {
      DREFYN_AUTH_DATABASE_POOL_MAX: '10',
      DREFYN_DATABASE_POOL_WAIT_MS: '10000',
    });
    app = await open.app(db.app, POOL);
  });

  it('counts 200 parallel reservations on one key exactly once each', async () => {
    const limit = 10;
    const counts = await Promise.all(
      Array.from({ length: 200 }, () =>
        reserveAuthRateWindows(auth, {
          bucket: 'email_send',
          keyHmac: key('parallel'),
          windowSeconds: [600],
        }),
      ),
    );
    const seen = counts.map(([window]) => window?.count ?? 0).sort((a, b) => a - b);
    expect(seen).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    expect(seen.filter((count) => count <= limit)).toHaveLength(limit);
  });

  it('counts 200 parallel API key failures on one key exactly once each', async () => {
    const counts = await Promise.all(
      Array.from({ length: 200 }, () =>
        reserveApiKeyFailureWindows(app, { keyHmac: key('api'), windowSeconds: [60] }),
      ),
    );
    const seen = counts.map(([window]) => window?.count ?? 0).sort((a, b) => a - b);
    expect(seen).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
  });

  it('keeps each window and each bucket apart, and says when each window ends', async () => {
    const reserve = (bucket: string, label: string) =>
      reserveAuthRateWindows(auth, {
        bucket,
        keyHmac: key(label),
        windowSeconds: [600, 86_400],
      });
    await reserve('email_send', 'apart');
    const second = await reserve('email_send', 'apart');
    const other = await reserve('email_send_ip', 'apart');
    expect(second.map((w) => [w.windowSeconds, w.count])).toEqual([
      [600, 2],
      [86_400, 2],
    ]);
    expect(other.map((w) => w.count)).toEqual([1, 1]);
    for (const window of second) {
      expect(window.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(window.retryAfterSeconds).toBeLessThanOrEqual(window.windowSeconds);
    }
  });

  it('aligns windows to database time, so every app host agrees', async () => {
    await reserveAuthRateWindows(auth, {
      bucket: 'oauth_start',
      keyHmac: key('aligned'),
      windowSeconds: [600],
    });
    const out = await superuser(
      `select extract(epoch from window_start)::bigint % 600 = 0
          and window_end - window_start = interval '600 seconds'
          and window_start <= now() and now() < window_end
         from app.auth_rate_limits where bucket = 'oauth_start';`,
      db.name,
    );
    expect(out.trim()).toBe('t');
  });

  it('stores the key only as given, 32 bytes, and never the value behind it', async () => {
    await reserveAuthRateWindows(auth, {
      bucket: 'code_verify',
      keyHmac: key('stored'),
      windowSeconds: [3600],
    });
    const out = await superuser(
      `select encode(key_hmac, 'hex') from app.auth_rate_limits where bucket = 'code_verify';`,
      db.name,
    );
    expect(out.trim()).toBe(key('stored').toString('hex'));
  });

  // A wrong code or password is thrown from the work, which rolls its transaction back. The
  // reservation must already have committed, or failed attempts would never count.
  describe('reservations commit before the work they limit', () => {
    const limit = 10;
    const failing = async (label: string, reached: { n: number }) => {
      const [window] = await reserveAuthRateWindows(auth, {
        bucket: 'password_fail',
        keyHmac: key(label),
        windowSeconds: [3600],
      });
      if ((window?.count ?? Infinity) > limit) return 'limited';
      await withAuth(auth, () => {
        reached.n += 1;
        return Promise.reject(new Error('wrong password'));
      }).catch(() => undefined);
      return 'reached';
    };

    it('counts 40 sequential attempts whose work throws', async () => {
      const reached = { n: 0 };
      for (let i = 0; i < 40; i += 1) await failing('sequential', reached);
      expect(reached.n).toBe(limit);
      const out = await superuser(
        `select count from app.auth_rate_limits where bucket = 'password_fail'
            and key_hmac = decode('${key('sequential').toString('hex')}', 'hex');`,
        db.name,
      );
      expect(out.trim()).toBe('40');
    });

    it('lets at most the limit of 200 parallel throwing attempts reach the work', async () => {
      const reached = { n: 0 };
      const results = await Promise.all(
        Array.from({ length: 200 }, () => failing('parallel', reached)),
      );
      expect(reached.n).toBe(limit);
      expect(results.filter((r) => r === 'limited')).toHaveLength(200 - limit);
    });

    it('counts API key failures before the work too', async () => {
      const counts: WindowCount[][] = [];
      for (let i = 0; i < 5; i += 1) {
        counts.push([
          ...(await reserveApiKeyFailureWindows(app, {
            keyHmac: key('api-throw'),
            windowSeconds: [60],
          })),
        ]);
        await withApiKeyLimiter(app, () => Promise.reject(new Error('bad key'))).catch(
          () => undefined,
        );
      }
      expect(counts.map(([w]) => w?.count)).toEqual([1, 2, 3, 4, 5]);
    });
  });

  // Slow work after a reservation (a password hash) must not hold the key's row lock.
  it('keeps another key fast while one key does slow work after reserving', async () => {
    const pool = await open.auth(authUrl(db));
    const hot = Array.from({ length: 12 }, async () => {
      await reserveAuthRateWindows(pool, {
        bucket: 'password_fail_ip',
        keyHmac: key('hot'),
        windowSeconds: [600],
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    await reserveAuthRateWindows(pool, {
      bucket: 'password_fail_ip',
      keyHmac: key('cold'),
      windowSeconds: [600],
    });
    const waited = Date.now() - started;
    await Promise.all(hot);
    expect(waited).toBeLessThan(500);
  });
});
