import { createHash } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import {
  reserveApiKeyFailureWindows,
  reserveAuthRateWindows,
  withApiKeyLimiter,
  withAuth,
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
        withAuth(auth, (tx) =>
          reserveAuthRateWindows(tx, {
            bucket: 'email_send',
            keyHmac: key('parallel'),
            windowSeconds: [600],
          }),
        ),
      ),
    );
    const seen = counts.map(([window]) => window?.count ?? 0).sort((a, b) => a - b);
    expect(seen).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    expect(seen.filter((count) => count <= limit)).toHaveLength(limit);
  });

  it('counts 200 parallel API key failures on one key exactly once each', async () => {
    const counts = await Promise.all(
      Array.from({ length: 200 }, () =>
        withApiKeyLimiter(app, (tx) =>
          reserveApiKeyFailureWindows(tx, { keyHmac: key('api'), windowSeconds: [60] }),
        ),
      ),
    );
    const seen = counts.map(([window]) => window?.count ?? 0).sort((a, b) => a - b);
    expect(seen).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
  });

  it('keeps each window and each bucket apart, and says when each window ends', async () => {
    const reserve = (bucket: string, label: string) =>
      withAuth(auth, (tx) =>
        reserveAuthRateWindows(tx, {
          bucket,
          keyHmac: key(label),
          windowSeconds: [600, 86_400],
        }),
      );
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
    await withAuth(auth, (tx) =>
      reserveAuthRateWindows(tx, {
        bucket: 'oauth_start',
        keyHmac: key('aligned'),
        windowSeconds: [600],
      }),
    );
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
    await withAuth(auth, (tx) =>
      reserveAuthRateWindows(tx, {
        bucket: 'code_verify',
        keyHmac: key('stored'),
        windowSeconds: [3600],
      }),
    );
    const out = await superuser(
      `select encode(key_hmac, 'hex') from app.auth_rate_limits where bucket = 'code_verify';`,
      db.name,
    );
    expect(out.trim()).toBe(key('stored').toString('hex'));
  });
});
