import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { roleUrl, serverEnv, stackFile } from '../../e2e/stack-env.ts';
import { curl } from './support/curl.ts';

const root = join(import.meta.dirname, '..', '..');
const ORIGIN = 'http://127.0.0.1:3110';
const HOP_ORIGIN = 'https://app.drefyn.test';

async function query(text: string): Promise<string> {
  const client = new pg.Client(roleUrl(stackFile(), 'postgres', 'DREFYN_POSTGRES_PASSWORD'));
  await client.connect();
  try {
    const result = await client.query({ text, rowMode: 'array' });
    return String((result.rows as unknown[][])[0]?.[0]);
  } finally {
    await client.end();
  }
}

const keys = () =>
  query(`select count(distinct key_hmac) from app.auth_rate_limits where bucket = 'email_send_ip'`);

function start(port: number, origin: string, extra: Record<string, string>): ChildProcess {
  return spawn(process.execPath, ['server.ts'], {
    cwd: root,
    env: {
      PATH: process.env['PATH'],
      NODE_ENV: 'production',
      HOSTNAME: '127.0.0.1',
      PORT: String(port),
      NEXT_TELEMETRY_DISABLED: '1',
      DREFYN_FLAGS_SOURCE: 'file',
      DREFYN_FLAGS_FILE: join(root, 'e2e', 'flags', 'on.json'),
      ...serverEnv(origin),
      ...extra,
    },
    stdio: 'ignore',
  });
}

const execute = promisify(execFile);

// curl, because it sends Host and X-Forwarded-For exactly as given; fetch replaces Host.
async function post(
  port: number,
  headers: readonly string[],
  fields: ReadonlyMap<string, string>,
): Promise<void> {
  const args = ['--silent', '--http1.1', '--noproxy', '*', '--output', '/dev/null'];
  for (const header of headers) args.push('--header', header);
  for (const [name, value] of fields) args.push('--form-string', `${name}=${value}`);
  await execute('curl', [...args, `http://127.0.0.1:${String(port)}/sign-in`]);
}

async function ready(port: number): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    try {
      await curl(port, '/robots.txt', ['Host: 127.0.0.1']);
      return;
    } catch {
      await new Promise((wake) => setTimeout(wake, 200));
    }
  }
  throw new Error('the server did not start');
}

// The form as a browser with scripts off would post it: every hidden field from the page,
// plus the address. Two fresh browsers, so only the client address can join their counts.
async function postStart(port: number, host: string, origin: string, forwarded: string) {
  const common = [`Host: ${host}`, `X-Forwarded-For: ${forwarded}`];
  const minted = await curl(port, '/auth/pre?to=%2Fsign-in', common);
  const cookie = (minted.headers['set-cookie'] ?? '').split(';')[0] ?? '';
  const page = await curl(port, '/sign-in', [...common, `Cookie: ${cookie}`]);
  const fields = new Map<string, string>();
  for (const [, name, value] of page.body.matchAll(
    /<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?/g,
  )) {
    if (name !== undefined) fields.set(name, (value ?? '').replaceAll('&quot;', '"'));
  }
  fields.set('email', 'bucket@example.dev');
  await post(port, [...common, `Cookie: ${cookie}`, `Origin: ${origin}`], fields);
}

describe('the client address through the wrapper into a real bucket', () => {
  let servers: ChildProcess[] = [];

  beforeAll(async () => {
    servers = [
      start(3110, ORIGIN, { DREFYN_AUTH_RATE_EMAIL_SEND_IP: '1000/10m' }),
      start(3111, HOP_ORIGIN, {
        DREFYN_TRUSTED_PROXY_HOPS: '1',
        DREFYN_AUTH_COOKIE_SECURE: 'true',
        DREFYN_AUTH_RATE_EMAIL_SEND_IP: '1000/10m',
      }),
    ];
    await Promise.all([ready(3110), ready(3111)]);
  });

  afterAll(() => {
    for (const server of servers) server.kill('SIGKILL');
  });

  it('two spoofed X-Forwarded-For values from one socket make one key', async () => {
    await query('delete from app.auth_rate_limits');
    await postStart(3110, '127.0.0.1:3110', ORIGIN, '6.6.6.6');
    await postStart(3110, '127.0.0.1:3110', ORIGIN, '7.7.7.7');
    expect(await keys()).toBe('1');
  });

  it('with hops 1, two proxy views make two keys', async () => {
    await query('delete from app.auth_rate_limits');
    await postStart(3111, 'app.drefyn.test', HOP_ORIGIN, '198.51.100.7');
    await postStart(3111, 'app.drefyn.test', HOP_ORIGIN, '198.51.100.8');
    expect(await keys()).toBe('2');
  });
});
