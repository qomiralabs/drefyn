import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import pg from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';
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

// Windows start on the database clock, so a burst can run across the end of one window and
// be counted from 1 again in the next. The stored rows say which happened; every count must
// still be handed out exactly once within its window.
async function storedCounts(table: 'auth_rate_limits' | 'api_key_failures', where: string) {
  const out = await superuser(
    `select count from app.${table} where ${where} order by window_start;`,
    db.name,
  );
  return out.trim().split('\n').map(Number);
}

const keyIs = (label: string) => `key_hmac = decode('${key(label).toString('hex')}', 'hex')`;

const handedOut = (rows: readonly number[]) =>
  rows.flatMap((n) => Array.from({ length: n }, (_, i) => i + 1)).sort((a, b) => a - b);

const underLimit = (rows: readonly number[], limit: number) =>
  rows.reduce((sum, n) => sum + Math.min(n, limit), 0);

const total = (rows: readonly number[]) => rows.reduce((sum, n) => sum + n, 0);

const noop = () => undefined;

type Query = (...args: unknown[]) => unknown;

// Stands in for the app process stalling (a GC pause, a busy event loop) right after its
// reservation reaches the server: every later query on that connection waits for release.
function stallAfter(table: string) {
  const original = Reflect.get(pg.Client.prototype, 'query') as Query;
  const gate = Promise.withResolvers<undefined>();
  const stalled = new WeakSet<object>();
  let chosen = false;
  function query(this: object, ...args: unknown[]): unknown {
    const send = () => Reflect.apply(original, this, args);
    if (stalled.has(this)) return gate.promise.then(send);
    if (!chosen && typeof args[0] === 'string' && args[0].includes(`insert into app.${table}`)) {
      chosen = true;
      stalled.add(this);
    }
    return send();
  }
  vi.spyOn(pg.Client.prototype, 'query').mockImplementation(query);
  return {
    release: () => {
      gate.resolve(undefined);
    },
  };
}

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
    const rows = await storedCounts(
      'auth_rate_limits',
      `bucket = 'email_send' and ${keyIs('parallel')}`,
    );
    expect(total(rows)).toBe(200);
    expect(rows.length).toBeLessThanOrEqual(2);
    expect(seen).toEqual(handedOut(rows));
    expect(seen.filter((count) => count <= limit)).toHaveLength(underLimit(rows, limit));
  });

  it('counts 200 parallel API key failures on one key exactly once each', async () => {
    const counts = await Promise.all(
      Array.from({ length: 200 }, () =>
        reserveApiKeyFailureWindows(app, { keyHmac: key('api'), windowSeconds: [60] }),
      ),
    );
    const seen = counts.map(([window]) => window?.count ?? 0).sort((a, b) => a - b);
    const rows = await storedCounts('api_key_failures', keyIs('api'));
    expect(total(rows)).toBe(200);
    expect(rows.length).toBeLessThanOrEqual(2);
    expect(seen).toEqual(handedOut(rows));
  });

  // Two reservations on one key while one of them stalls. The stalled one is held until the
  // other has settled, so if its row lock outlived the round trip, the other would time out.
  async function stallOne(
    table: 'auth_rate_limits' | 'api_key_failures',
    reserve: () => Promise<readonly WindowCount[]>,
  ) {
    const stall = stallAfter(table);
    const both = [reserve(), reserve()];
    try {
      await Promise.race(both.map((p) => p.then(noop, noop)));
    } finally {
      stall.release();
    }
    const settled = await Promise.allSettled(both);
    expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'fulfilled']);
    return Promise.all(both);
  }

  it('never holds the row lock of a key while the app process stalls', async () => {
    const request = { bucket: 'email_verify', keyHmac: key('stall'), windowSeconds: [600] };
    const counts = await stallOne('auth_rate_limits', () => reserveAuthRateWindows(auth, request));
    const rows = await storedCounts(
      'auth_rate_limits',
      `bucket = 'email_verify' and ${keyIs('stall')}`,
    );
    expect(total(rows)).toBe(2);
    expect(counts.map(([w]) => w?.count).sort()).toEqual(handedOut(rows));
  });

  it('never holds the row lock of an API key while the app process stalls', async () => {
    const request = { keyHmac: key('api-stall'), windowSeconds: [600] };
    const counts = await stallOne('api_key_failures', () =>
      reserveApiKeyFailureWindows(app, request),
    );
    const rows = await storedCounts('api_key_failures', keyIs('api-stall'));
    expect(total(rows)).toBe(2);
    expect(counts.map(([w]) => w?.count).sort()).toEqual(handedOut(rows));
  });

  it('gives up on a key whose row stays locked, after the reservation timeout', async () => {
    const request = { bucket: 'email_verify', keyHmac: key('locked'), windowSeconds: [600] };
    await reserveAuthRateWindows(auth, request);
    const other = await open.auth(authUrl(db));
    const outcome = await withAuth(auth, async (tx) => {
      await sql`select 1 from app.auth_rate_limits where ${sql.raw(keyIs('locked'))} for update`.execute(
        tx,
      );
      return reserveAuthRateWindows(other, request).catch((error: unknown) => error);
    });
    expect(outcome).toMatchObject({ code: 'DB_TIMEOUT' });
    expect(total(await storedCounts('auth_rate_limits', keyIs('locked')))).toBe(1);
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
      const rows = await storedCounts(
        'auth_rate_limits',
        `bucket = 'password_fail' and ${keyIs('sequential')}`,
      );
      expect(total(rows)).toBe(40);
      expect(rows.length).toBeLessThanOrEqual(2);
      expect(reached.n).toBe(underLimit(rows, limit));
    });

    it('lets at most the limit of 200 parallel throwing attempts reach the work', async () => {
      const reached = { n: 0 };
      const results = await Promise.all(
        Array.from({ length: 200 }, () => failing('parallel', reached)),
      );
      const rows = await storedCounts(
        'auth_rate_limits',
        `bucket = 'password_fail' and ${keyIs('parallel')}`,
      );
      expect(total(rows)).toBe(200);
      expect(rows.length).toBeLessThanOrEqual(2);
      expect(reached.n).toBe(underLimit(rows, limit));
      expect(results.filter((r) => r === 'limited')).toHaveLength(200 - underLimit(rows, limit));
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
      const rows = await storedCounts('api_key_failures', keyIs('api-throw'));
      expect(total(rows)).toBe(5);
      expect(rows.length).toBeLessThanOrEqual(2);
      // In order: 1 to 5, or counting from 1 again once the window ends.
      const expected = rows.flatMap((n) => Array.from({ length: n }, (_, i) => i + 1));
      expect(counts.map(([w]) => w?.count)).toEqual(expected);
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
