import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// The production build behind server.ts. CI always builds first, so a missing build fails
// there instead of skipping.
const root = join(import.meta.dirname, '..', '..');
const built = existsSync(join(root, '.next', 'BUILD_ID'));
const runBuilt = built || process.env['CI'] === 'true';

const dir = mkdtempSync(join(tmpdir(), 'drefyn-sso-start-'));
const write = (name: string, text: string) => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Boot reads the lists and connects to nothing, so no database runs behind this.
const ENV = {
  NODE_ENV: 'production',
  NEXT_TELEMETRY_DISABLED: '1',
  PORT: '0',
  HOSTNAME: '127.0.0.1',
  UV_THREADPOOL_SIZE: '16',
  DREFYN_APP_ORIGIN: 'https://app.drefyn.test',
  DREFYN_FLAGS_SOURCE: 'file',
  DREFYN_FLAGS_FILE: join(root, 'e2e', 'flags', 'on.json'),
  DREFYN_AUTH_SECRET: randomBytes(32).toString('base64url'),
  DREFYN_AUTH_INVITATION_BLOCK_KEY: randomBytes(32).toString('base64url'),
  DREFYN_DATABASE_URL: 'postgres://app:app@127.0.0.1:1/drefyn',
  DREFYN_AUTH_DATABASE_URL: 'postgres://auth:auth@127.0.0.1:1/drefyn',
  DREFYN_DATABASE_SSL: 'disable',
} as const;

const SETTLED = /"event":"dashboard\.(sso_lists_loaded|config_invalid)"/;

async function boot(extra: Record<string, string>) {
  const child = spawn(process.execPath, ['server.ts'], {
    cwd: root,
    env: { PATH: process.env['PATH'], ...ENV, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  let running = true;
  const exited = new Promise<number | null>((done) => {
    child.once('exit', (code) => {
      running = false;
      done(code);
    });
  });
  const started = Date.now();
  // Read through a function, since the exit handler changes it between awaits.
  const alive = () => running;
  while (!SETTLED.test(output) && alive() && Date.now() - started < 45_000) {
    await new Promise((wake) => setTimeout(wake, 100));
  }
  // A refused start exits on its own; give it the moment it needs.
  await Promise.race([exited, new Promise((wake) => setTimeout(wake, 1_000))]);
  const stayedUp = alive();
  child.kill('SIGTERM');
  const code = await exited;
  return { output, stayedUp, code };
}

describe.runIf(runBuilt)('the SSO domain lists at start of the built server', () => {
  it('reads the bundled Public Suffix List and the extra free mail file', async () => {
    const file = write('extra.txt', '# ours\nmail.acme-free.example\nposteo.example\n');
    const { output, stayedUp } = await boot({ DREFYN_AUTH_SSO_FREE_MAIL_DOMAINS_FILE: file });
    const line = /\{[^\n]*"event":"dashboard\.sso_lists_loaded"[^\n]*\}/.exec(output)?.[0];
    expect(line, output).toBeDefined();
    const fields = JSON.parse(line ?? '{}') as Record<string, unknown>;
    expect(fields['extraFreeMail']).toBe(2);
    expect(Number(fields['publicSuffixes'])).toBeGreaterThan(5000);
    expect(stayedUp).toBe(true);
  }, 60_000);

  it('refuses to start on a free mail file that holds a line that is not a domain', async () => {
    const file = write('bad.txt', 'mail.acme-free.example\nhttps://secret-line.example/x\n');
    const { output, stayedUp, code } = await boot({ DREFYN_AUTH_SSO_FREE_MAIL_DOMAINS_FILE: file });
    expect(output).toContain('"event":"dashboard.config_invalid"');
    expect(output).toContain('"key":"DREFYN_AUTH_SSO_FREE_MAIL_DOMAINS_FILE"');
    expect(output).not.toContain('secret-line');
    expect(stayedUp).toBe(false);
    expect(code).toBe(1);
  }, 60_000);
});
