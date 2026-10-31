import { beforeAll, expect, it } from 'vitest';
import {
  API_KEY_EXPIRY_RULES,
  AUTH_EXPIRY_RULES,
  createExpiryCleanup,
  deleteExpired,
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

let db: TestDatabase;
let auth: AuthDatabase;
let app: Database;

// Rows placed relative to the database clock, so app host time plays no part. Each table
// gets one row just past its cut off and one just before it.
async function seedRows(): Promise<void> {
  await superuser(
    `insert into app.auth_rate_limits (bucket, key_hmac, window_start, window_end, count) values
       ('email_send', decode(repeat('01', 32), 'hex'), now() - interval '20 minutes', now() - interval '10 minutes', 3),
       ('email_send', decode(repeat('02', 32), 'hex'), now() - interval '5 minutes', now() + interval '5 minutes', 1);
     insert into app.api_key_failures (key_hmac, window_start, window_end, count) values
       (decode(repeat('03', 32), 'hex'), now() - interval '2 minutes', now() - interval '1 minute', 9),
       (decode(repeat('04', 32), 'hex'), now() - interval '30 seconds', now() + interval '30 seconds', 1);
     insert into app.email_challenges (email_normalized, purpose, code_hmac, browser_hash, expires_at) values
       ('old@example.com', 'sign_in', decode(repeat('05', 32), 'hex'), decode(repeat('05', 32), 'hex'), now() - interval '25 hours'),
       ('new@example.com', 'sign_in', decode(repeat('06', 32), 'hex'), decode(repeat('06', 32), 'hex'), now() - interval '23 hours');
     insert into app.oauth_states (state_hash, provider, purpose, code_verifier, browser_hash, expires_at) values
       (decode(repeat('07', 32), 'hex'), 'github', 'sign_in', repeat('v', 43), decode(repeat('07', 32), 'hex'), now() - interval '25 hours'),
       (decode(repeat('08', 32), 'hex'), 'github', 'sign_in', repeat('v', 43), decode(repeat('08', 32), 'hex'), now() - interval '1 hour');`,
    db.name,
  );
}

async function remaining(): Promise<string> {
  return (
    await superuser(
      `select (select string_agg(encode(key_hmac, 'hex'), ',') from app.auth_rate_limits) || '|' ||
              (select string_agg(encode(key_hmac, 'hex'), ',') from app.api_key_failures) || '|' ||
              (select string_agg(email_normalized, ',') from app.email_challenges) || '|' ||
              (select string_agg(encode(state_hash, 'hex'), ',') from app.oauth_states);`,
      db.name,
    )
  ).trim();
}

describeWithStack('expiry cleanup', () => {
  beforeAll(async () => {
    db = await dbs.fresh('migrated');
    auth = await open.auth(authUrl(db));
    app = await open.app(db.app);
    await seedRows();
  });

  it('removes ended windows and rows 24 hours past expiry, keeps the rest and counts', async () => {
    const authCounts = await withAuth(auth, (tx) => deleteExpired(tx, AUTH_EXPIRY_RULES));
    const apiCounts = await withApiKeyLimiter(app, (tx) => deleteExpired(tx, API_KEY_EXPIRY_RULES));
    expect(authCounts).toEqual({ auth_rate_limits: 1, email_challenges: 1, oauth_states: 1 });
    expect(apiCounts).toEqual({ api_key_failures: 1 });
    expect(await remaining()).toBe(
      ['02'.repeat(32), '04'.repeat(32), 'new@example.com', '08'.repeat(32)].join('|'),
    );
    const again = await withAuth(auth, (tx) => deleteExpired(tx, AUTH_EXPIRY_RULES));
    expect(again).toEqual({ auth_rate_limits: 0, email_challenges: 0, oauth_states: 0 });
  });

  it('deletes at most the batch size per table in one run', async () => {
    await superuser(
      `insert into app.oauth_states (state_hash, provider, purpose, code_verifier, browser_hash, expires_at)
       select sha256(i::text::bytea), 'google', 'sign_in', repeat('v', 43), sha256(i::text::bytea),
              now() - interval '2 days'
         from generate_series(1, 5) i;`,
      db.name,
    );
    const first = await withAuth(auth, (tx) =>
      deleteExpired(tx, AUTH_EXPIRY_RULES, { batchSize: 3 }),
    );
    expect(first['oauth_states']).toBe(3);
    const second = await withAuth(auth, (tx) =>
      deleteExpired(tx, AUTH_EXPIRY_RULES, { batchSize: 3 }),
    );
    expect(second['oauth_states']).toBe(2);
  });

  it('adds up two rules on one table under that table', async () => {
    const counts = await withAuth(auth, (tx) =>
      deleteExpired(tx, [
        { table: 'email_challenges', column: 'expires_at', afterSeconds: 86_400 },
        { table: 'email_challenges', column: 'created_at', afterSeconds: 0 },
      ]),
    );
    // The row 23 hours past expiry was created before now, so the second rule takes it.
    expect(counts).toEqual({ email_challenges: 1 });
  });

  it('runs through the throttled runner against the real pool', async () => {
    const counted: [string, number][] = [];
    const cleanup = createExpiryCleanup({
      rules: AUTH_EXPIRY_RULES,
      transact: (work) => withAuth(auth, work),
      onDeleted: (table, count) => counted.push([table, count]),
    });
    const result = await cleanup.maybeRun();
    expect(result).toEqual({ auth_rate_limits: 0, email_challenges: 0, oauth_states: 0 });
    expect(counted).toEqual([
      ['auth_rate_limits', 0],
      ['email_challenges', 0],
      ['oauth_states', 0],
    ]);
    expect(await cleanup.maybeRun()).toBeNull();
  });
});
