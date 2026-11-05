import { expect } from '@playwright/test';
import { authSql, organizationSql } from './auth-helpers.ts';
import { VAULT_ID, VAULT_KEY_INSIDE_LIMIT } from './people.ts';
import { test } from './test.ts';

// The running servers on the real stack, with nothing but their own timers. Every server in
// this suite has one, flag on and flag off, and the first turn comes within a minute of start.
test('a running server purges the key past 90 days and leaves the younger one', async () => {
  test.setTimeout(150_000);
  await expect
    .poll(() => organizationSql(VAULT_ID, 'select id from app.api_keys order by id'), {
      timeout: 120_000,
      intervals: [2000],
    })
    .toBe(VAULT_KEY_INSIDE_LIMIT);
  // One run, then quiet: the next is an hour out, however many servers are asking.
  const quiet = await authSql(
    `select last_run_at is not null as ran, next_run_at > now() + interval '30 minutes' as quiet
       from app.scheduled_jobs where name = 'auth_expiry'`,
  );
  expect(quiet).toBe('true|true');
});
