import { connect, createServer as createNetServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { guardedFetchWith } from '../src/fetch.ts';
import { policyFor } from '../src/policy.ts';
import type { EgressPolicy } from '../src/types.ts';
import {
  type Fixture,
  fakeRuntime,
  type Handler,
  httpFixture,
  httpsFixture,
  makeCertificate,
  silentSocket,
} from './support/runtime.ts';

const PUBLIC = '93.184.215.14';
const OTHER = '93.184.215.15';
const NAMES = {
  'fixture.test': [PUBLIC],
  'other.test': [OTHER],
  'private.test': ['10.0.0.5'],
};
const open: Fixture[] = [];

async function serve(handler: Handler): Promise<Fixture> {
  const fixture = await httpFixture(handler);
  open.push(fixture);
  return fixture;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
});

const monitor = (change: Partial<EgressPolicy> = {}): EgressPolicy => ({
  ...policyFor('monitor'),
  ...change,
});

describe('guardedFetch over plain HTTP', () => {
  it('sends to the checked address with the name in Host and returns the answer', async () => {
    const server = await serve((_req, res) => {
      res.setHeader('x-answer', 'yes');
      res.end('hello');
    });
    const { runtime, dials } = fakeRuntime(NAMES);
    const url = `http://fixture.test:${server.port}/path?q=1`;
    const result = await guardedFetchWith(runtime, url, {}, monitor());
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.status).toBe(200);
    expect(result.value.headers.get('x-answer')).toBe('yes');
    expect(Buffer.from(result.value.body).toString()).toBe('hello');
    expect(result.value.url).toBe(url);
    expect(result.value.redirects).toBe(0);
    expect(result.value.address).toEqual({ address: PUBLIC, family: 4 });
    expect(dials).toEqual([{ address: PUBLIC, port: server.port }]);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.headers.host).toBe(`fixture.test:${server.port}`);
    expect(server.requests[0]?.url).toBe('/path?q=1');
    expect(server.requests[0]?.headers.connection).toBe('close');
  });

  it('sends the method, headers and body, and owns the framing headers', async () => {
    const server = await serve((_req, res) => res.end());
    const { runtime } = fakeRuntime(NAMES);
    const result = await guardedFetchWith(
      runtime,
      `http://fixture.test:${server.port}/hook`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: 'evil.test',
          'content-length': '1',
          'transfer-encoding': 'chunked',
          connection: 'keep-alive',
        },
        body: '{"a":"é"}',
      },
      monitor(),
    );
    expect(result.ok).toBe(true);
    const seen = server.requests[0];
    expect(seen?.method).toBe('POST');
    expect(seen?.body).toBe('{"a":"é"}');
    expect(seen?.headers.host).toBe(`fixture.test:${server.port}`);
    expect(seen?.headers['content-length']).toBe('10');
    expect(seen?.headers['transfer-encoding']).toBeUndefined();
    expect(seen?.headers['content-type']).toBe('application/json');
  });

  it('sends a byte body as given', async () => {
    const server = await serve((_req, res) => res.end());
    const { runtime } = fakeRuntime(NAMES);
    const body = new TextEncoder().encode('bytes');
    await guardedFetchWith(
      runtime,
      `http://fixture.test:${server.port}/`,
      { method: 'PUT', body },
      monitor(),
    );
    expect(server.requests[0]?.body).toBe('bytes');
  });

  it('connects to an address literal without a lookup', async () => {
    const server = await serve((_req, res) => res.end('ok'));
    const { runtime, dials, lookups } = fakeRuntime(NAMES);
    const result = await guardedFetchWith(
      runtime,
      `http://${PUBLIC}:${server.port}/`,
      {},
      monitor(),
    );
    expect(result.ok).toBe(true);
    expect(lookups).toEqual([]);
    expect(dials).toEqual([{ address: PUBLIC, port: server.port }]);
    expect(server.requests[0]?.headers.host).toBe(`${PUBLIC}:${server.port}`);
  });

  it('tries the next checked address when one refuses the connection', async () => {
    const server = await serve((_req, res) => res.end('ok'));
    const { runtime, dials } = fakeRuntime(
      { 'two.test': [OTHER, PUBLIC] },
      {
        connect: ({ address, port }) =>
          connect({ host: '127.0.0.1', port: address === OTHER ? 1 : port }),
      },
    );
    const result = await guardedFetchWith(
      runtime,
      `http://two.test:${server.port}/`,
      {},
      monitor(),
    );
    expect(result.ok && result.value.address.address).toBe(PUBLIC);
    expect(dials.map((d) => d.address)).toEqual([OTHER, PUBLIC]);
  });

  it('reports a refused connection with its system code', async () => {
    const { runtime } = fakeRuntime(NAMES, {
      connect: () => connect({ host: '127.0.0.1', port: 1 }),
    });
    expect(await guardedFetchWith(runtime, 'http://fixture.test/', {}, monitor())).toEqual({
      ok: false,
      error: { code: 'egress.network_failed', hop: 0, cause: 'ECONNREFUSED' },
    });
  });

  it('gives up on a connect after connectTimeoutMs', async () => {
    const { runtime, dials } = fakeRuntime(
      { 'slow.test': [PUBLIC, OTHER] },
      { connect: () => silentSocket() },
    );
    const started = Date.now();
    const result = await guardedFetchWith(
      runtime,
      'http://slow.test/',
      {},
      monitor({ connectTimeoutMs: 50 }),
    );
    expect(result).toEqual({ ok: false, error: { code: 'egress.connect_timeout', hop: 0 } });
    expect(dials).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('stops the whole exchange at totalTimeoutMs when no answer comes', async () => {
    const server = await serve(() => {
      // Never answers.
    });
    const { runtime } = fakeRuntime(NAMES);
    const result = await guardedFetchWith(
      runtime,
      `http://fixture.test:${server.port}/`,
      {},
      monitor({ totalTimeoutMs: 100 }),
    );
    expect(result).toEqual({ ok: false, error: { code: 'egress.timeout', hop: 0 } });
  });

  it('stops a body that trickles in past totalTimeoutMs', async () => {
    const server = await serve((_req, res) => {
      res.write('a');
      const timer = setInterval(() => res.write('a'), 20);
      res.on('close', () => {
        clearInterval(timer);
      });
    });
    const { runtime } = fakeRuntime(NAMES);
    const result = await guardedFetchWith(
      runtime,
      `http://fixture.test:${server.port}/`,
      {},
      monitor({ totalTimeoutMs: 150 }),
    );
    expect(result).toEqual({ ok: false, error: { code: 'egress.timeout', hop: 0 } });
  });

  it('stops when a lookup takes longer than totalTimeoutMs', async () => {
    const { runtime } = fakeRuntime(NAMES);
    const slow = { ...runtime, lookup: () => new Promise<never>(() => undefined) };
    const result = await guardedFetchWith(
      slow,
      'http://fixture.test/',
      {},
      monitor({ totalTimeoutMs: 50 }),
    );
    expect(result).toEqual({ ok: false, error: { code: 'egress.timeout', hop: 0 } });
  });

  it('reports a caller abort as aborted, before and during the exchange', async () => {
    const server = await serve(() => undefined);
    const { runtime } = fakeRuntime(NAMES);
    const url = `http://fixture.test:${server.port}/`;
    expect(
      await guardedFetchWith(runtime, url, { signal: AbortSignal.abort() }, monitor()),
    ).toEqual({ ok: false, error: { code: 'egress.aborted', hop: 0 } });
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 50);
    expect(await guardedFetchWith(runtime, url, { signal: controller.signal }, monitor())).toEqual({
      ok: false,
      error: { code: 'egress.aborted', hop: 0 },
    });
  });

  it('refuses a body whose Content-Length is over the cap before reading it', async () => {
    const server = await serve((_req, res) => {
      res.setHeader('content-length', '2048');
      res.end('x'.repeat(2048));
    });
    const { runtime } = fakeRuntime(NAMES);
    const result = await guardedFetchWith(
      runtime,
      `http://fixture.test:${server.port}/`,
      {},
      monitor({ maxResponseBytes: 1024 }),
    );
    expect(result).toEqual({ ok: false, error: { code: 'egress.too_large', hop: 0 } });
  });

  it('stops reading a chunked body once it passes the cap', async () => {
    let written = 0;
    const server = await serve((_req, res) => {
      const timer = setInterval(() => {
        written += 512;
        res.write('x'.repeat(512));
      }, 5);
      res.on('close', () => {
        clearInterval(timer);
      });
    });
    const { runtime } = fakeRuntime(NAMES);
    const result = await guardedFetchWith(
      runtime,
      `http://fixture.test:${server.port}/`,
      {},
      monitor({ maxResponseBytes: 1024 }),
    );
    expect(result).toEqual({ ok: false, error: { code: 'egress.too_large', hop: 0 } });
    expect(written).toBeLessThan(64 * 1024);
  });

  it('accepts a body of exactly the cap', async () => {
    const server = await serve((_req, res) => res.end('x'.repeat(1024)));
    const { runtime } = fakeRuntime(NAMES);
    const result = await guardedFetchWith(
      runtime,
      `http://fixture.test:${server.port}/`,
      {},
      monitor({ maxResponseBytes: 1024 }),
    );
    expect(result.ok && result.value.body.byteLength).toBe(1024);
  });

  it('reports a connection cut mid body as network_failed', async () => {
    const server = await serve((req, res) => {
      res.setHeader('content-length', '100');
      res.write('partial');
      setTimeout(() => req.socket.destroy(), 10);
    });
    const { runtime } = fakeRuntime(NAMES);
    const result = await guardedFetchWith(
      runtime,
      `http://fixture.test:${server.port}/`,
      {},
      monitor(),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('egress.network_failed');
  });

  it('rejects a method that is not an HTTP token, which is a programming error', async () => {
    const { runtime, dials } = fakeRuntime(NAMES);
    await expect(
      guardedFetchWith(runtime, 'http://fixture.test/', { method: 'GET /x' }, monitor()),
    ).rejects.toThrow(TypeError);
    await expect(
      guardedFetchWith(
        runtime,
        'http://fixture.test/',
        { headers: { 'x-a': 'b\r\nc: d' } },
        monitor(),
      ),
    ).rejects.toThrow(TypeError);
    expect(dials).toEqual([]);
  });

  it('rejects an invalid policy, which is a programming error', async () => {
    const { runtime } = fakeRuntime(NAMES);
    await expect(
      guardedFetchWith(runtime, 'http://fixture.test/', {}, monitor({ maxRedirects: 9 as 5 })),
    ).rejects.toThrow(TypeError);
  });
});

describe('guardedFetch redirects', () => {
  it('follows redirects by hand and checks every hop again', async () => {
    const server = await serve((req, res) => {
      const hops: Record<string, string> = {
        '/a': '/b',
        '/b': `http://other.test:${String(req.socket.localPort)}/c`,
      };
      const next = hops[req.url ?? ''];
      if (next !== undefined) {
        res.writeHead(302, { location: next });
        res.end();
      } else {
        res.end('done');
      }
    });
    const { runtime, dials, lookups } = fakeRuntime(NAMES);
    const result = await guardedFetchWith(
      runtime,
      `http://fixture.test:${server.port}/a`,
      {},
      monitor(),
    );
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.redirects).toBe(2);
    expect(result.value.url).toBe(`http://other.test:${server.port}/c`);
    expect(result.value.address).toEqual({ address: OTHER, family: 4 });
    expect(dials.map((d) => d.address)).toEqual([PUBLIC, PUBLIC, OTHER]);
    expect(lookups).toEqual(['fixture.test', 'fixture.test', 'other.test']);
  });

  it.each([
    ['http://169.254.169.254/latest/meta-data/', 'egress.address_denied', 'linkLocal'],
    ['http://[::ffff:127.0.0.1]/', 'egress.address_denied', 'loopback'],
    ['http://private.test/', 'egress.address_denied', 'private'],
    ['http://localhost/', 'egress.host_denied', undefined],
    ['http://metadata.google.internal/', 'egress.host_denied', undefined],
    ['file:///etc/passwd', 'egress.scheme_denied', undefined],
    ['http://[::1', 'egress.url_invalid', undefined],
  ] as const)('refuses a redirect to %s at any hop', async (target, code, addressClass) => {
    for (const hop of [1, 3, 5]) {
      const server = await serve((req, res) => {
        const n = Number(req.url?.slice(1));
        res.writeHead(307, { location: n + 1 < hop ? `/${String(n + 1)}` : target });
        res.end();
      });
      const { runtime, dials } = fakeRuntime(NAMES);
      const result = await guardedFetchWith(
        runtime,
        `http://fixture.test:${server.port}/0`,
        {},
        monitor(),
      );
      expect(result).toEqual({
        ok: false,
        error: { code, hop, ...(addressClass === undefined ? {} : { addressClass }) },
      });
      expect(dials).toHaveLength(hop);
      expect(dials.every((d) => d.address === PUBLIC)).toBe(true);
    }
  });

  it('refuses one redirect more than the policy allows', async () => {
    const server = await serve((req, res) => {
      res.writeHead(301, { location: `/${String(Number(req.url?.slice(1)) + 1)}` });
      res.end();
    });
    const { runtime, dials } = fakeRuntime(NAMES);
    const result = await guardedFetchWith(
      runtime,
      `http://fixture.test:${server.port}/0`,
      {},
      monitor({ maxRedirects: 2 }),
    );
    expect(result).toEqual({ ok: false, error: { code: 'egress.too_many_redirects', hop: 3 } });
    expect(dials).toHaveLength(3);
  });

  it('refuses any redirect when the policy allows none, as webhooks do', async () => {
    const server = await serve((_req, res) => {
      res.writeHead(308, { location: '/elsewhere' });
      res.end();
    });
    const { runtime } = fakeRuntime(NAMES);
    const result = await guardedFetchWith(
      runtime,
      `http://fixture.test:${server.port}/`,
      {},
      monitor({ maxRedirects: 0 }),
    );
    expect(result).toEqual({ ok: false, error: { code: 'egress.too_many_redirects', hop: 1 } });
  });

  it('returns a redirect status with no Location as the answer', async () => {
    const server = await serve((_req, res) => {
      res.writeHead(302);
      res.end('no location');
    });
    const { runtime } = fakeRuntime(NAMES);
    const result = await guardedFetchWith(
      runtime,
      `http://fixture.test:${server.port}/`,
      {},
      monitor(),
    );
    expect(result.ok && result.value.status).toBe(302);
  });

  it('turns POST into GET on 303 and on 301 or 302, and keeps it on 307 and 308', async () => {
    for (const [status, method, body] of [
      [303, 'GET', ''],
      [302, 'GET', ''],
      [301, 'GET', ''],
      [307, 'POST', 'payload'],
      [308, 'POST', 'payload'],
    ] as const) {
      const server = await serve((req, res) => {
        if (req.url === '/start') {
          res.writeHead(status, { location: '/end' });
          res.end();
        } else {
          res.end();
        }
      });
      const { runtime } = fakeRuntime(NAMES);
      await guardedFetchWith(
        runtime,
        `http://fixture.test:${server.port}/start`,
        { method: 'POST', body: 'payload', headers: { 'content-type': 'text/plain' } },
        monitor(),
      );
      const second = server.requests[1];
      expect(second?.method, String(status)).toBe(method);
      expect(second?.body, String(status)).toBe(body);
      expect(second?.headers['content-type'], String(status)).toBe(
        body === '' ? undefined : 'text/plain',
      );
    }
  });

  it('keeps HEAD as HEAD on 303', async () => {
    const server = await serve((req, res) => {
      if (req.url === '/start') res.writeHead(303, { location: '/end' });
      res.end();
    });
    const { runtime } = fakeRuntime(NAMES);
    await guardedFetchWith(
      runtime,
      `http://fixture.test:${server.port}/start`,
      { method: 'HEAD' },
      monitor(),
    );
    expect(server.requests.map((r) => r.method)).toEqual(['HEAD', 'HEAD']);
  });

  it('drops credentials when a redirect leaves the origin, and keeps them when it stays', async () => {
    const server = await serve((req, res) => {
      const port = String(req.socket.localPort);
      const next: Record<string, string> = {
        '/1': '/2',
        '/2': `http://other.test:${port}/3`,
      };
      const location = next[req.url ?? ''];
      if (location !== undefined) res.writeHead(302, { location });
      res.end();
    });
    const { runtime } = fakeRuntime(NAMES);
    await guardedFetchWith(
      runtime,
      `http://fixture.test:${server.port}/1`,
      {
        headers: {
          authorization: 'Bearer t',
          cookie: 'a=b',
          'proxy-authorization': 'x',
          'x-keep': 'k',
        },
      },
      monitor(),
    );
    const [first, second, third] = server.requests;
    expect(first?.headers.authorization).toBe('Bearer t');
    expect(second?.headers.authorization).toBe('Bearer t');
    expect(second?.headers.cookie).toBe('a=b');
    expect(third?.headers.authorization).toBeUndefined();
    expect(third?.headers.cookie).toBeUndefined();
    expect(third?.headers['proxy-authorization']).toBeUndefined();
    expect(third?.headers['x-keep']).toBe('k');
  });
});

describe('guardedFetch over HTTPS', () => {
  const certificate = makeCertificate('fixture.test');

  async function serveTls(handler: Handler): Promise<Fixture> {
    const fixture = await httpsFixture(certificate, handler);
    open.push(fixture);
    return fixture;
  }

  it('keeps the name for SNI and Host while connecting to the checked address', async () => {
    const server = await serveTls((_req, res) => res.end('secure'));
    const { runtime, dials } = fakeRuntime(NAMES, { ca: certificate.cert });
    const result = await guardedFetchWith(
      runtime,
      `https://fixture.test:${server.port}/`,
      {},
      monitor(),
    );
    if (!result.ok) throw new Error(`${result.error.code} ${result.error.cause ?? ''}`);
    expect(Buffer.from(result.value.body).toString()).toBe('secure');
    expect(dials).toEqual([{ address: PUBLIC, port: server.port }]);
    expect(server.requests[0]?.sni).toBe('fixture.test');
    expect(server.requests[0]?.headers.host).toBe(`fixture.test:${server.port}`);
  });

  it('checks the certificate against the name, not the address', async () => {
    const server = await serveTls((_req, res) => res.end());
    const { runtime } = fakeRuntime({ 'wrong.test': [PUBLIC] }, { ca: certificate.cert });
    expect(
      await guardedFetchWith(runtime, `https://wrong.test:${server.port}/`, {}, monitor()),
    ).toEqual({
      ok: false,
      error: { code: 'egress.network_failed', hop: 0, cause: 'ERR_TLS_CERT_ALTNAME_INVALID' },
    });
  });

  it('refuses a certificate no trusted CA signed', async () => {
    const server = await serveTls((_req, res) => res.end());
    const { runtime } = fakeRuntime(NAMES);
    const result = await guardedFetchWith(
      runtime,
      `https://fixture.test:${server.port}/`,
      {},
      monitor(),
    );
    expect(result).toEqual({
      ok: false,
      error: { code: 'egress.network_failed', hop: 0, cause: 'DEPTH_ZERO_SELF_SIGNED_CERT' },
    });
  });

  it('checks an address literal against the certificate without sending it as SNI', async () => {
    const server = await serveTls((_req, res) => res.end());
    const { runtime } = fakeRuntime(NAMES, { ca: certificate.cert });
    const result = await guardedFetchWith(
      runtime,
      `https://${PUBLIC}:${server.port}/`,
      {},
      monitor(),
    );
    expect(result).toEqual({
      ok: false,
      error: { code: 'egress.network_failed', hop: 0, cause: 'ERR_TLS_CERT_ALTNAME_INVALID' },
    });
  });

  it('counts the TLS handshake inside the connect timeout', async () => {
    // Accepts the TCP connection and never answers the TLS hello.
    const held: Socket[] = [];
    const server = createNetServer((socket) => {
      socket.resume();
      held.push(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = address !== null && typeof address === 'object' ? address.port : 0;
    try {
      const { runtime } = fakeRuntime(NAMES, { ca: certificate.cert });
      const result = await guardedFetchWith(
        runtime,
        `https://fixture.test:${String(port)}/`,
        {},
        monitor({ connectTimeoutMs: 100 }),
      );
      expect(result).toEqual({ ok: false, error: { code: 'egress.connect_timeout', hop: 0 } });
    } finally {
      for (const socket of held) socket.destroy();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    }
  });
});
