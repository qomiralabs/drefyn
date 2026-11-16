import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SERVER = join(import.meta.dirname, '..', 'server.ts');
const RATE_KEY = randomBytes(32).toString('base64url');
const AUTH_SECRET = randomBytes(32).toString('base64url');
const AUTH_URL = 'postgres://drefyn_auth:canary-auth-password@127.0.0.1:1/drefyn';

interface Exit {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

// The real entry point as an operator runs it, so the refusal is proved for the process and
// not only for a function it calls.
function runServer(env: Record<string, string>): Promise<Exit> {
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env['PATH'] ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdout = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, stdout });
    });
  });
}

const base = {
  DREFYN_API_RATE_LIMIT_KEY: RATE_KEY,
  DREFYN_API_PORT: '0',
  // Nothing listens on port 1, so a start that got as far as connecting would fail differently.
  DREFYN_DATABASE_URL: 'postgres://drefyn_app:canary-app-password@127.0.0.1:1/drefyn',
  DREFYN_PUBLIC_READER_DATABASE_URL:
    'postgres://drefyn_public_reader:canary-reader-password@127.0.0.1:1/drefyn',
  DREFYN_DATABASE_SSL: 'disable',
  DREFYN_DATABASE_POOL_WAIT_MS: '200',
};

function failure(exit: Exit): Record<string, unknown> {
  const line = exit.stderr
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .find((l) => l['event'] === 'api.start_failed');
  if (line === undefined) throw new Error(`no start failure in: ${exit.stderr}`);
  return line;
}

describe('the API service refuses to start beside auth', () => {
  it.each([
    ['DREFYN_AUTH_DATABASE_URL', AUTH_URL],
    ['DREFYN_AUTH_SECRET', AUTH_SECRET],
    ['DREFYN_AUTH_SECRET_PREVIOUS', AUTH_SECRET],
  ])('exits 1 with %s set, naming the key and never the value', async (key, value) => {
    const exit = await runServer({ ...base, [key]: value });
    expect(exit.code).toBe(1);
    expect(failure(exit)).toEqual({
      level: 'error',
      event: 'api.start_failed',
      service: 'api',
      error: 'AuthError',
      code: 'AUTH_CONFIG_INVALID',
      key,
    });
    expect(exit.stderr + exit.stdout).not.toContain(value);
    expect(exit.stderr).not.toContain('canary');
    // It stopped before any pool: no line says it got to listening.
    expect(exit.stderr).not.toContain('api.listening');
  });

  it('exits 1 without the failure limiter key', async () => {
    const rest = Object.fromEntries(
      Object.entries(base).filter(([key]) => key !== 'DREFYN_API_RATE_LIMIT_KEY'),
    );
    const exit = await runServer(rest);
    expect(exit.code).toBe(1);
    expect(failure(exit)).toMatchObject({
      code: 'AUTH_CONFIG_INVALID',
      key: 'DREFYN_API_RATE_LIMIT_KEY',
    });
  });

  it('exits 1 on a bad API setting, naming the key', async () => {
    const exit = await runServer({ ...base, DREFYN_API_PORT: 'eighty' });
    expect(exit.code).toBe(1);
    expect(failure(exit)).toMatchObject({ error: 'ApiConfigError', key: 'DREFYN_API_PORT' });
  });

  it('exits 1 when the database cannot be reached, with no password in the log', async () => {
    const exit = await runServer(base);
    expect(exit.code).toBe(1);
    expect(failure(exit)).toMatchObject({ error: 'DbError', code: 'DB_UNAVAILABLE' });
    expect(exit.stderr).not.toContain('canary');
  });
});
