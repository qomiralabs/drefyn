import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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

  it('refuses an absolute form request line with the right Host, before the handler', async () => {
    const before = zero.seen.length;
    const reply = await curl(zero.port, '/', [HOST], 'http://evil.example/');
    expect(reply.status).toBe(400);
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

// Boot parses these and connects to nothing, so no database runs behind this job.
const AUTH_ENV = {
  DREFYN_AUTH_SECRET: randomBytes(32).toString('base64url'),
  DREFYN_AUTH_INVITATION_BLOCK_KEY: randomBytes(32).toString('base64url'),
  DREFYN_DATABASE_URL: 'postgres://app:app@127.0.0.1:1/drefyn',
  DREFYN_AUTH_DATABASE_URL: 'postgres://auth:auth@127.0.0.1:1/drefyn',
  DREFYN_DATABASE_SSL: 'disable',
};

interface Started {
  readonly child: ChildProcess;
  readonly port: number;
  // Everything the server has logged so far.
  readonly log: () => string;
}

async function startBuilt(): Promise<Started> {
  const child = spawn(process.execPath, ['server.ts'], {
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
      ...AUTH_ENV,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const port = await new Promise<number>((done, fail) => {
    const timer = setTimeout(() => {
      fail(new Error(`server did not start: ${output}`));
    }, 60_000);
    const read = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const match = /"event":"dashboard\.listening"[^}]*"port":(\d+)/.exec(output);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        done(Number(match[1]));
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('exit', (code) => {
      fail(new Error(`server exited ${String(code)}: ${output}`));
    });
  });
  return { child, port, log: () => output };
}

const UPGRADE = ['Connection: Upgrade', 'Upgrade: websocket'];

describe.runIf(runBuilt)('the built server behind server.ts', () => {
  let child: ChildProcess;
  let port = 0;
  let log: () => string;

  beforeAll(async () => {
    ({ child, port, log } = await startBuilt());
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

  it.each(['http://evil.example/', '//evil.example/', '/\\evil.example/'])(
    'refuses the request target %s, so no redirect can name that host',
    async (target) => {
      const reply = await curl(port, '/', [HOST], target);
      expect(reply.status).toBe(400);
      expect(reply.headers['location']).toBeUndefined();
    },
  );

  it('answers a forged Host upgrade with 421, also after a routed request', async () => {
    // Next attaches its own listener on the first routed request, so this must come first.
    expect((await curl(port, '/', [HOST])).status).toBeLessThan(500);
    const reply = await curl(port, '/', ['Host: evil.example', ...UPGRADE]);
    expect(reply.status).toBe(421);
  });

  it('finishes a valid Host upgrade within a second, after a routed request', async () => {
    // Next's listener only exists after one, and it would leave this socket open.
    await curl(port, '/', [HOST]);
    const started = Date.now();
    const reply = await curl(port, '/', [HOST, ...UPGRADE]);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(reply.status).toBeLessThan(500);
  });

  it('logs auth.threadpool_small never when the pool is 16', () => {
    expect(log()).not.toContain('auth.threadpool_small');
  });
});

describe.runIf(runBuilt)('stopping the built server', () => {
  it('exits on SIGTERM within 2 s after an upgrade attempt', async () => {
    const { child, port } = await startBuilt();
    try {
      await curl(port, '/', [HOST]);
      // Not awaited: on a socket left open this would hold the connection for its 5 s.
      const attempt = curl(port, '/', [HOST, ...UPGRADE], undefined, 5).catch(() => undefined);
      await new Promise((done) => setTimeout(done, 300));
      const exited = new Promise<number | null>((done) => {
        child.once('exit', done);
      });
      const started = Date.now();
      child.kill('SIGTERM');
      const code = await Promise.race([
        exited,
        new Promise<'still running'>((done) => {
          setTimeout(() => {
            done('still running');
          }, 2_000);
        }),
      ]);
      expect(code).toBe(0);
      expect(Date.now() - started).toBeLessThan(2_000);
      await attempt;
    } finally {
      child.kill('SIGKILL');
    }
  }, 90_000);
});

describe.runIf(runBuilt)('next start on the production build', () => {
  it('exits 1 with the marker absent, and logs why', async () => {
    const child = spawn(
      process.execPath,
      [join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '--port', '0'],
      {
        cwd: root,
        env: {
          PATH: process.env['PATH'],
          NODE_ENV: 'production',
          NEXT_TELEMETRY_DISABLED: '1',
          DREFYN_APP_ORIGIN: ORIGIN,
          DREFYN_FLAGS_SOURCE: 'file',
          DREFYN_FLAGS_FILE: join(root, 'e2e', 'flags', 'on.json'),
          ...AUTH_ENV,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    const code = await new Promise<number | null>((done, fail) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        fail(new Error(`next start stayed up: ${output}`));
      }, 30_000);
      child.on('exit', (exit) => {
        clearTimeout(timer);
        done(exit);
      });
    });
    expect(code).toBe(1);
    expect(output).toContain('"event":"dashboard.wrapper_missing"');
  });
});

describe.runIf(runBuilt)('mail through the built server', () => {
  const TRANSPORT = {
    DREFYN_EMAIL_TRANSPORT: 'smtp',
    DREFYN_EMAIL_FROM: 'drefyn@example.dev',
    DREFYN_SMTP_HOST: '127.0.0.1',
    DREFYN_SMTP_PORT: '51025',
    DREFYN_SMTP_TLS: 'none',
    DREFYN_SMTP_ALLOW_PLAINTEXT: 'true',
  };

  async function bootLog(nodeArgs: readonly string[], extra: Record<string, string>) {
    const child = spawn(process.execPath, [...nodeArgs, 'server.ts'], {
      cwd: root,
      env: {
        PATH: process.env['PATH'],
        NODE_ENV: 'production',
        HOSTNAME: '127.0.0.1',
        PORT: '0',
        UV_THREADPOOL_SIZE: '16',
        NEXT_TELEMETRY_DISABLED: '1',
        DREFYN_APP_ORIGIN: ORIGIN,
        DREFYN_FLAGS_SOURCE: 'file',
        DREFYN_FLAGS_FILE: join(root, 'e2e', 'flags', 'on.json'),
        ...AUTH_ENV,
        ...extra,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    const exited = new Promise<void>((done) => {
      child.once('exit', () => {
        done();
      });
    });
    const settled = /dashboard\.email_(ready|load_failed)/;
    const started = Date.now();
    while (!settled.test(output) && child.exitCode === null && Date.now() - started < 30_000) {
      await new Promise((wake) => setTimeout(wake, 100));
    }
    const stayedUp = child.exitCode === null;
    child.kill('SIGTERM');
    await exited;
    return { output, stayedUp };
  }

  it('loads the mail package through Node with the flag on and a transport set', async () => {
    const { output, stayedUp } = await bootLog([], TRANSPORT);
    expect(output).toContain('"event":"dashboard.email_ready"');
    expect(stayedUp).toBe(true);
  }, 60_000);

  it('keeps serving when the package fails to load, and says so without detail', async () => {
    const breaker = join(root, 'test', 'integration', 'support', 'break-email.ts');
    const { output, stayedUp } = await bootLog(['--import', breaker], TRANSPORT);
    expect(output).toContain('"event":"dashboard.email_load_failed"');
    expect(output).not.toContain('Cannot find package');
    expect(stayedUp).toBe(true);
  }, 60_000);
});
