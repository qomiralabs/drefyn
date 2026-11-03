import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseWrapperConfig } from '../../src/server/client-ip.ts';
import { HEALTH_PATH } from '../../src/server/wrapper.ts';
import { curl } from './support/curl.ts';
import { startEcho, type Echo } from './support/echo.ts';

const ORIGIN = 'https://app.drefyn.test';
const HOST = 'Host: app.drefyn.test';

describe('the wrapper over a real socket, with Next replaced by an echo', () => {
  let zero: Echo;
  let one: Echo;

  beforeAll(async () => {
    zero = await startEcho(parseWrapperConfig({ DREFYN_APP_ORIGIN: ORIGIN }));
    one = await startEcho(
      parseWrapperConfig({ DREFYN_APP_ORIGIN: ORIGIN, DREFYN_TRUSTED_PROXY_HOPS: '1' }),
    );
  });

  afterAll(async () => {
    await zero.close();
    await one.close();
  });

  it('gives two requests from one socket with different spoofed X-Forwarded-For the same one value', async () => {
    const a = await curl(zero.port, '/', [HOST, 'X-Forwarded-For: 6.6.6.6']);
    const b = await curl(zero.port, '/', [
      HOST,
      'X-Forwarded-For: 7.7.7.7, 8.8.8.8',
      'X-Forwarded-For: 9.9.9.9',
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const first = zero.seen.at(-2)?.['x-forwarded-for'];
    const second = zero.seen.at(-1)?.['x-forwarded-for'];
    expect(first).toBe('127.0.0.1');
    expect(second).toBe(first);
    expect(zero.warnings).toEqual(['auth.forwarded_header_ignored']);
  });

  it('with hops 1, the proxy view of the client wins over a client supplied prefix', async () => {
    await curl(one.port, '/', [HOST, 'X-Forwarded-For: 6.6.6.6, 198.51.100.7']);
    expect(one.seen.at(-1)?.['x-forwarded-for']).toBe('198.51.100.7');
  });

  it('removes every other client address header before Next sees the request', async () => {
    await curl(zero.port, '/', [
      HOST,
      'Forwarded: for=6.6.6.6',
      'X-Real-IP: 6.6.6.6',
      'CF-Connecting-IP: 6.6.6.6',
      'True-Client-IP: 6.6.6.6',
      'CloudFront-Viewer-Address: 6.6.6.6:443',
    ]);
    const seen = zero.seen.at(-1) ?? {};
    for (const name of [
      'forwarded',
      'x-real-ip',
      'cf-connecting-ip',
      'true-client-ip',
      'cloudfront-viewer-address',
    ]) {
      expect(seen[name], name).toBeUndefined();
    }
  });

  it.each([
    ['X-Forwarded-Host: evil.example', 'x-forwarded-host', 'app.drefyn.test'],
    ['X-Forwarded-Proto: http', 'x-forwarded-proto', 'https'],
    ['X-Forwarded-Port: 8080', 'x-forwarded-port', '443'],
  ])('replaces a forged %s with the origin value', async (forged, name, want) => {
    await curl(zero.port, '/', [HOST, forged]);
    expect(zero.seen.at(-1)?.[name]).toBe(want);
  });

  it('answers a forged Host with 421 and never reaches the handler', async () => {
    const before = zero.seen.length;
    const reply = await curl(zero.port, '/', ['Host: evil.example']);
    expect(reply.status).toBe(421);
    expect(zero.seen.length).toBe(before);
  });

  it('answers the health check on its own path on the loopback host', async () => {
    const before = zero.seen.length;
    const reply = await curl(zero.port, HEALTH_PATH, [`Host: 127.0.0.1:${String(zero.port)}`]);
    expect(reply.status).toBe(200);
    expect(reply.body).toBe('ok\n');
    expect(zero.seen.length).toBe(before);
  });
});

// The production build behind server.ts. Build first with `pnpm --filter @drefyn/dashboard
// build`; CI always does, so a missing build fails there instead of skipping.
const root = join(import.meta.dirname, '..', '..');
const built = existsSync(join(root, '.next', 'BUILD_ID'));
const runBuilt = built || process.env['CI'] === 'true';

describe.runIf(runBuilt)('the built server behind server.ts', () => {
  let child: ChildProcess;
  let port = 0;
  let output = '';

  beforeAll(async () => {
    child = spawn(process.execPath, ['server.ts'], {
      cwd: root,
      env: {
        PATH: process.env['PATH'],
        NODE_ENV: 'production',
        NEXT_TELEMETRY_DISABLED: '1',
        PORT: '0',
        HOSTNAME: '127.0.0.1',
        UV_THREADPOOL_SIZE: '16',
        DREFYN_APP_ORIGIN: ORIGIN,
        DREFYN_FLAGS_SOURCE: 'file',
        DREFYN_FLAGS_FILE: join(root, 'e2e', 'flags', 'on.json'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    port = await new Promise<number>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`server did not start: ${output}`)), 60_000);
      const read = (chunk: Buffer) => {
        output += chunk.toString('utf8');
        const match = /"event":"dashboard\.listening"[^}]*"port":(\d+)/.exec(output);
        if (match?.[1] !== undefined) {
          clearTimeout(timer);
          done(Number(match[1]));
        }
      };
      child.stdout?.on('data', read);
      child.stderr?.on('data', read);
      child.on('exit', (code) => fail(new Error(`server exited ${String(code)}: ${output}`)));
    });
  }, 90_000);

  afterAll(() => {
    child.kill('SIGTERM');
  });

  it('answers a forged Host with 421 from the wrapper', async () => {
    const reply = await curl(port, '/', ['Host: evil.example']);
    expect(reply.status).toBe(421);
    expect(reply.body).toBe('misdirected request\n');
  });

  it('answers the health check on the loopback host', async () => {
    const reply = await curl(port, HEALTH_PATH, [`Host: 127.0.0.1:${String(port)}`]);
    expect(reply.status).toBe(200);
  });

  it('a redirect under forged forwarding headers points inside the origin', async () => {
    const reply = await curl(port, '/', [
      HOST,
      'X-Forwarded-Host: evil.example',
      'X-Forwarded-Proto: http',
      'X-Forwarded-Port: 8080',
      'X-Forwarded-For: 6.6.6.6',
    ]);
    expect([303, 307, 308]).toContain(reply.status);
    const location = reply.headers['location'] ?? '';
    const relative = location.startsWith('/') && !location.startsWith('//');
    expect(relative || location.startsWith(`${ORIGIN}/`), location).toBe(true);
  });

  it('logs auth.threadpool_small never when the pool is 16', () => {
    expect(output).not.toContain('auth.threadpool_small');
  });
});
