import { DbError, type AuthDatabase, type ExpiryJobResult, type ExpiryRun } from '@drefyn/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openExpiryRun, reportExpiryRun, startExpiryJob } from '../src/server/expiry-job.ts';

const ORG = '01900000-0000-7000-8000-000000000e01';

function lines() {
  const seen: Record<string, unknown>[] = [];
  const capture = (text: string) => seen.push(JSON.parse(text) as Record<string, unknown>);
  vi.spyOn(console, 'info').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  return seen;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('reportExpiryRun', () => {
  const DONE: ExpiryRun = {
    outcome: 'done',
    counts: { api_keys: 3, oauth_states: 0 },
    organizations: [{ table: 'api_keys', organizationId: ORG, deleted: 3 }],
  };

  it('logs the counts and one line per organization', () => {
    const seen = lines();
    reportExpiryRun(DONE);
    expect(seen).toContainEqual({
      level: 'info',
      event: 'dashboard.expiry_done',
      service: 'dashboard',
      api_keys: 3,
      oauth_states: 0,
    });
    expect(seen).toContainEqual({
      level: 'info',
      event: 'dashboard.expiry_deleted',
      service: 'dashboard',
      organizationId: ORG,
      table: 'api_keys',
      deleted: 3,
    });
  });

  it('keeps every line to ids, table names, counts and fixed words', () => {
    const seen = lines();
    reportExpiryRun(DONE);
    reportExpiryRun({ outcome: 'failed', code: 'DB_UNAVAILABLE', attempt: 2 });
    const allowed = new Set([
      'level',
      'event',
      'service',
      'api_keys',
      'oauth_states',
      'organizationId',
      'table',
      'deleted',
      'metric',
      'outcome',
      'value',
      'code',
      'attempt',
    ]);
    for (const line of seen) {
      for (const key of Object.keys(line)) expect(allowed).toContain(key);
    }
    expect(JSON.stringify(seen)).not.toMatch(/secret|hash|drk_/i);
  });

  it('makes a failed run visible as a metric and a warning', () => {
    const seen = lines();
    reportExpiryRun({ outcome: 'failed', code: 'DB_UNAVAILABLE', attempt: 2 });
    expect(seen).toContainEqual({
      level: 'warn',
      event: 'dashboard.expiry_failed',
      service: 'dashboard',
      code: 'DB_UNAVAILABLE',
      attempt: 2,
    });
    expect(seen).toContainEqual({
      level: 'info',
      event: 'dashboard.metric',
      service: 'dashboard',
      metric: 'expiry_job_runs_total',
      outcome: 'failed',
      value: 1,
    });
  });

  it('counts a good run under the same metric', () => {
    const seen = lines();
    reportExpiryRun(DONE);
    expect(seen).toContainEqual(
      expect.objectContaining({ metric: 'expiry_job_runs_total', outcome: 'done', value: 1 }),
    );
  });
});

describe('openExpiryRun', () => {
  it('refuses bad settings at run time, so a bad start never takes the server down', async () => {
    await expect(openExpiryRun({})()).rejects.toBeInstanceOf(DbError);
  });

  it('opens the pool once, on one connection, and asks again after a failed open', async () => {
    const env = { DREFYN_AUTH_DATABASE_URL: 'postgres://u:p@127.0.0.1:1/d' };
    const db = {} as AuthDatabase;
    const open = vi
      .fn<(config: { poolMax: number }) => Promise<AuthDatabase>>()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue(db);
    const job = vi.fn<(database: AuthDatabase) => Promise<ExpiryJobResult>>(() =>
      Promise.resolve({ ran: false }),
    );
    const run = openExpiryRun({ ...env, DREFYN_DATABASE_SSL: 'disable' }, { open, job });
    await expect(run()).rejects.toThrow('down');
    await run();
    await run();
    expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.calls[1]?.[0]).toMatchObject({ poolMax: 1 });
    expect(job).toHaveBeenCalledTimes(2);
  });
});

describe('startExpiryJob', () => {
  it('reports a failed first run and stops cleanly, with no database to reach', async () => {
    vi.useFakeTimers();
    const seen = lines();
    const job = startExpiryJob({});
    await vi.advanceTimersByTimeAsync(61_000);
    job.stop();
    expect(seen).toContainEqual(
      expect.objectContaining({ event: 'dashboard.expiry_failed', code: 'DB_CONFIG_INVALID' }),
    );
  });
});
