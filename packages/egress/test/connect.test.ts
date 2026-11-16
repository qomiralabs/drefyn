import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { guardedConnectWith } from '../src/connect.ts';
import { guardedConnect, guardedFetch, guardedResolve } from '../src/index.ts';
import { policyFor } from '../src/policy.ts';
import { guardedResolveWith } from '../src/resolve.ts';
import type { EgressPolicy } from '../src/types.ts';
import { fakeRuntime, silentSocket } from './support/runtime.ts';

const PUBLIC = '93.184.215.14';
const servers: Server[] = [];

async function tcpServer(onSocket: (socket: Socket) => void = (s) => s.end('hi')): Promise<number> {
  const server = createServer(onSocket);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

const monitor = (change: Partial<EgressPolicy> = {}): EgressPolicy => ({
  ...policyFor('monitor'),
  ...change,
});

describe('guardedResolve', () => {
  it('returns every checked address for a public name', async () => {
    const { runtime } = fakeRuntime({ 'two.test': [PUBLIC, '2606:4700::1111', PUBLIC] });
    expect(await guardedResolveWith(runtime, 'two.test', monitor())).toEqual({
      ok: true,
      value: [
        { address: PUBLIC, family: 4 },
        { address: '2606:4700::1111', family: 6 },
      ],
    });
  });

  it('checks a literal without a lookup, in either IPv6 form', async () => {
    const { runtime, lookups } = fakeRuntime({});
    expect(await guardedResolveWith(runtime, '2606:4700::1111', monitor())).toEqual({
      ok: true,
      value: [{ address: '2606:4700::1111', family: 6 }],
    });
    expect(await guardedResolveWith(runtime, '[2606:4700::1111]', monitor())).toEqual({
      ok: true,
      value: [{ address: '2606:4700::1111', family: 6 }],
    });
    expect(await guardedResolveWith(runtime, '0x7f.1', monitor())).toEqual({
      ok: false,
      error: { code: 'egress.address_denied', hop: 0, addressClass: 'loopback' },
    });
    expect(lookups).toEqual([]);
  });

  it.each([
    ['localhost', 'egress.host_denied'],
    ['metadata.google.internal', 'egress.host_denied'],
    ['a.example.com/path', 'egress.url_invalid'],
    ['user@a.example.com', 'egress.url_invalid'],
    ['a.example.com:80', 'egress.url_invalid'],
    ['a.example.com?x', 'egress.url_invalid'],
    ['a.example.com#x', 'egress.url_invalid'],
    ['a.example.com\\x', 'egress.url_invalid'],
    ['', 'egress.url_invalid'],
    ['[::1', 'egress.url_invalid'],
  ] as const)('refuses the host %j with %s', async (host, code) => {
    const { runtime, lookups } = fakeRuntime({});
    expect(await guardedResolveWith(runtime, host, monitor())).toEqual({
      ok: false,
      error: { code, hop: 0 },
    });
    expect(lookups).toEqual([]);
  });

  it('times out a lookup that never answers', async () => {
    const { runtime } = fakeRuntime({});
    const slow = { ...runtime, lookup: () => new Promise<never>(() => undefined) };
    expect(
      await guardedResolveWith(slow, 'a.example.com', monitor({ totalTimeoutMs: 30 })),
    ).toEqual({
      ok: false,
      error: { code: 'egress.timeout', hop: 0 },
    });
  });

  it('lets listed private ranges through and resolves names a public policy refuses', async () => {
    const { runtime } = fakeRuntime({ 'db.internal': ['10.1.2.3'] });
    const policy = monitor({ allowPrivate: { cidrs: ['10.0.0.0/8'] } });
    expect(await guardedResolveWith(runtime, 'db.internal', policy)).toEqual({
      ok: true,
      value: [{ address: '10.1.2.3', family: 4 }],
    });
    expect(await guardedResolveWith(runtime, '10.9.9.9', policy)).toEqual({
      ok: true,
      value: [{ address: '10.9.9.9', family: 4 }],
    });
  });

  it('uses the system resolver by default', async () => {
    const policy = monitor({ allowPrivate: { cidrs: ['127.0.0.0/8', '::1/128'] } });
    const result = await guardedResolve('localhost', policy);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.length).toBeGreaterThan(0);
    expect(await guardedResolve('localhost', monitor())).toEqual({
      ok: false,
      error: { code: 'egress.host_denied', hop: 0 },
    });
  });
});

describe('guardedConnect', () => {
  it('returns a connected socket to the checked address', async () => {
    const port = await tcpServer();
    const { runtime, dials } = fakeRuntime({ 'tcp.test': [PUBLIC] });
    const result = await guardedConnectWith(runtime, 'tcp.test', port, monitor());
    if (!result.ok) throw new Error(result.error.code);
    const text = await new Promise<string>((resolve) => {
      let got = '';
      result.value.on('data', (chunk: Buffer) => (got += chunk.toString()));
      result.value.on('end', () => {
        resolve(got);
      });
    });
    expect(text).toBe('hi');
    expect(dials).toEqual([{ address: PUBLIC, port }]);
  });

  it.each([
    ['127.0.0.1', 80, 'egress.address_denied'],
    ['localhost', 80, 'egress.host_denied'],
    ['tcp.test', 0, 'egress.port_denied'],
    ['tcp.test', 65_536, 'egress.port_denied'],
    ['tcp.test', 1.5, 'egress.port_denied'],
  ] as const)('refuses %s port %d with %s', async (host, port, code) => {
    const { runtime, dials } = fakeRuntime({ 'tcp.test': [PUBLIC] });
    const result = await guardedConnectWith(runtime, host, port, monitor());
    expect(!result.ok && result.error.code).toBe(code);
    expect(dials).toEqual([]);
  });

  it('applies the port list of the policy', async () => {
    const { runtime } = fakeRuntime({ 'tcp.test': [PUBLIC] });
    const result = await guardedConnectWith(runtime, 'tcp.test', 22, policyFor('feed'));
    expect(result).toEqual({ ok: false, error: { code: 'egress.port_denied', hop: 0 } });
  });

  it('times out and reports refusals', async () => {
    const { runtime } = fakeRuntime({ 'tcp.test': [PUBLIC] }, { connect: () => silentSocket() });
    expect(
      await guardedConnectWith(runtime, 'tcp.test', 80, monitor({ connectTimeoutMs: 30 })),
    ).toEqual({
      ok: false,
      error: { code: 'egress.connect_timeout', hop: 0 },
    });
    const refused = fakeRuntime(
      { 'tcp.test': [PUBLIC] },
      { connect: () => silentSocket().connect(1, '127.0.0.1') },
    );
    expect(await guardedConnectWith(refused.runtime, 'tcp.test', 80, monitor())).toEqual({
      ok: false,
      error: { code: 'egress.network_failed', hop: 0, cause: 'ECONNREFUSED' },
    });
  });

  it('connects with the default runtime to an allowed private address', async () => {
    const port = await tcpServer();
    const policy = monitor({ allowPrivate: { cidrs: ['127.0.0.1/32'] } });
    const result = await guardedConnect('127.0.0.1', port, policy);
    expect(result.ok).toBe(true);
    if (result.ok) result.value.destroy();
  });
});

describe('the public entry', () => {
  it('fetches with the default runtime from an allowed private address', async () => {
    const port = await tcpServer((socket) => {
      socket.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok');
    });
    const policy = monitor({ allowPrivate: { cidrs: ['127.0.0.1/32'] } });
    const result = await guardedFetch(`http://127.0.0.1:${String(port)}/`, {}, policy);
    expect(result.ok && Buffer.from(result.value.body).toString()).toBe('ok');
  });
});
