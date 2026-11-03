import fc from 'fast-check';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  FORWARDING_HEADERS,
  WrapperConfigError,
  createThrottle,
  hostMatches,
  parseIp,
  parseWrapperConfig,
  resolveClientAddress,
  rewriteHeaders,
  smallThreadPool,
  type WrapperConfig,
} from '../src/server/client-ip.ts';
import { HEALTH_PATH, createWrapper, startWrapper } from '../src/server/wrapper.ts';

const ORIGIN = 'https://app.drefyn.test';
const config = (env: Record<string, string> = {}) =>
  parseWrapperConfig({ DREFYN_APP_ORIGIN: ORIGIN, ...env });

function refusal(work: () => unknown): WrapperConfigError {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(WrapperConfigError);
    return error as WrapperConfigError;
  }
  throw new Error('expected a refusal');
}

describe('wrapper settings', () => {
  it('reads the origin and defaults to no trusted hops', () => {
    expect(config()).toEqual({
      origin: {
        protocol: 'https',
        host: 'app.drefyn.test',
        hostname: 'app.drefyn.test',
        port: '443',
      },
      hops: 0,
      viewerHeader: false,
    });
    expect(config({ DREFYN_TRUSTED_PROXY_HOPS: '2' }).hops).toBe(2);
    expect(parseWrapperConfig({ DREFYN_APP_ORIGIN: 'http://localhost:3000' }).origin).toEqual({
      protocol: 'http',
      host: 'localhost:3000',
      hostname: 'localhost',
      port: '3000',
    });
  });

  it.each([
    [{}, 'DREFYN_APP_ORIGIN'],
    [{ DREFYN_APP_ORIGIN: 'https://app.drefyn.test/path' }, 'DREFYN_APP_ORIGIN'],
    [{ DREFYN_APP_ORIGIN: 'ftp://app.drefyn.test' }, 'DREFYN_APP_ORIGIN'],
    [{ DREFYN_APP_ORIGIN: 'https://user@app.drefyn.test' }, 'DREFYN_APP_ORIGIN'],
    [{ DREFYN_APP_ORIGIN: ORIGIN, DREFYN_TRUSTED_PROXY_HOPS: '-1' }, 'DREFYN_TRUSTED_PROXY_HOPS'],
    [{ DREFYN_APP_ORIGIN: ORIGIN, DREFYN_TRUSTED_PROXY_HOPS: '1.5' }, 'DREFYN_TRUSTED_PROXY_HOPS'],
    [{ DREFYN_APP_ORIGIN: ORIGIN, DREFYN_TRUSTED_PROXY_HOPS: '11' }, 'DREFYN_TRUSTED_PROXY_HOPS'],
    [{ DREFYN_APP_ORIGIN: ORIGIN, DREFYN_TRUSTED_PROXY_HOPS: ' 1' }, 'DREFYN_TRUSTED_PROXY_HOPS'],
    [
      {
        DREFYN_APP_ORIGIN: ORIGIN,
        DREFYN_TRUSTED_PROXY_HOPS: '1',
        DREFYN_CLIENT_IP_HEADER: 'x-real-ip',
      },
      'DREFYN_CLIENT_IP_HEADER',
    ],
    [
      { DREFYN_APP_ORIGIN: ORIGIN, DREFYN_CLIENT_IP_HEADER: 'cloudfront-viewer-address' },
      'DREFYN_CLIENT_IP_HEADER',
    ],
  ])('refuses %j naming %s', (env, key) => {
    expect(refusal(() => parseWrapperConfig(env)).key).toBe(key);
  });

  it.each(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'])(
    'refuses hops above 0 for the loopback origin %s',
    (origin) => {
      const error = refusal(() =>
        parseWrapperConfig({ DREFYN_APP_ORIGIN: origin, DREFYN_TRUSTED_PROXY_HOPS: '1' }),
      );
      expect(error.key).toBe('DREFYN_TRUSTED_PROXY_HOPS');
      expect(error.message).toContain('loopback');
    },
  );

  it('never puts a value it read into a refusal', () => {
    const error = refusal(() =>
      parseWrapperConfig({ DREFYN_APP_ORIGIN: 'https://secret-host.example/x?token=abc' }),
    );
    expect(error.message).not.toContain('secret-host');
    expect(error.message).not.toContain('abc');
  });
});

describe('the thread pool check', () => {
  it.each([
    [{}, 'unset'],
    [{ UV_THREADPOOL_SIZE: '' }, 'unset'],
    [{ UV_THREADPOOL_SIZE: '4' }, '4'],
    [{ UV_THREADPOOL_SIZE: '15' }, '15'],
    [{ UV_THREADPOOL_SIZE: 'lots' }, 'lots'],
  ])('reports %j as small, with the value read', (env, value) => {
    expect(smallThreadPool(env)).toBe(value);
  });

  it.each([['16'], ['64']])('is quiet for %s', (size) => {
    expect(smallThreadPool({ UV_THREADPOOL_SIZE: size })).toBeNull();
  });

  it('logs auth.threadpool_small once at startup and never sets the variable', () => {
    const warn = vi.fn();
    const env: Record<string, string | undefined> = { DREFYN_APP_ORIGIN: ORIGIN };
    startWrapper(env, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('auth.threadpool_small', { value: 'unset', wanted: 16 });
    expect(env).toEqual({ DREFYN_APP_ORIGIN: ORIGIN });
    const quiet = vi.fn();
    startWrapper({ DREFYN_APP_ORIGIN: ORIGIN, UV_THREADPOOL_SIZE: '16' }, quiet);
    expect(quiet).not.toHaveBeenCalled();
  });

  it('fails startup for a loopback origin with hops above 0', () => {
    expect(() =>
      startWrapper(
        { DREFYN_APP_ORIGIN: 'http://localhost:3000', DREFYN_TRUSTED_PROXY_HOPS: '1' },
        vi.fn(),
      ),
    ).toThrow(WrapperConfigError);
  });
});

describe('IP literals', () => {
  it.each([
    ['203.0.113.9', '203.0.113.9'],
    ['2001:db8::1', '2001:db8::1'],
    ['::ffff:203.0.113.9', '::ffff:203.0.113.9'],
    ['::1', '::1'],
  ])('accepts %s', (text, want) => {
    expect(parseIp(text)).toBe(want);
  });

  it.each([
    [''],
    ['unknown'],
    ['203.0.113.256'],
    ['203.0.113.09'],
    ['203.0.113'],
    ['[2001:db8::1]'],
    ['2001:db8::1%eth0'],
    ['203.0.113.9:443'],
    ['2001:db8:::1'],
    ['1:2:3:4:5:6:7:8:9'],
    [' 203.0.113.9'],
  ])('refuses %j', (text) => {
    expect(parseIp(text)).toBeNull();
  });
});

describe('client address resolution', () => {
  const socket = '192.0.2.50';

  it('uses the socket with 0 hops, whatever the headers say', () => {
    expect(
      resolveClientAddress({ socket, forwardedFor: '6.6.6.6', viewer: undefined }, config()),
    ).toEqual({ address: socket, chainInvalid: false });
  });

  it('with 1 hop, takes the proxy view over a client supplied prefix', () => {
    const one = config({ DREFYN_TRUSTED_PROXY_HOPS: '1' });
    expect(
      resolveClientAddress(
        { socket, forwardedFor: '6.6.6.6, 7.7.7.7, 198.51.100.7', viewer: undefined },
        one,
      ),
    ).toEqual({ address: '198.51.100.7', chainInvalid: false });
  });

  it('with 2 hops, takes the second address from the right', () => {
    const two = config({ DREFYN_TRUSTED_PROXY_HOPS: '2' });
    expect(
      resolveClientAddress(
        { socket, forwardedFor: '6.6.6.6, 198.51.100.7, 10.0.0.2', viewer: undefined },
        two,
      ),
    ).toEqual({ address: '198.51.100.7', chainInvalid: false });
  });

  it('falls back to the left most trusted entry on a short chain and flags it', () => {
    const two = config({ DREFYN_TRUSTED_PROXY_HOPS: '2' });
    expect(
      resolveClientAddress({ socket, forwardedFor: '10.0.0.2', viewer: undefined }, two),
    ).toEqual({ address: '10.0.0.2', chainInvalid: true });
    expect(
      resolveClientAddress({ socket, forwardedFor: undefined, viewer: undefined }, two),
    ).toEqual({ address: socket, chainInvalid: true });
  });

  it('falls back on an unparsable candidate, and to the socket when the trusted entry is bad too', () => {
    const two = config({ DREFYN_TRUSTED_PROXY_HOPS: '2' });
    expect(
      resolveClientAddress({ socket, forwardedFor: 'nonsense, 10.0.0.2', viewer: undefined }, two),
    ).toEqual({ address: '10.0.0.2', chainInvalid: true });
    expect(
      resolveClientAddress({ socket, forwardedFor: '198.51.100.7, junk', viewer: undefined }, two),
    ).toEqual({ address: socket, chainInvalid: true });
  });

  it('reads the CloudFront viewer address only when configured, from the trusted hop', () => {
    const cf = config({
      DREFYN_TRUSTED_PROXY_HOPS: '1',
      DREFYN_CLIENT_IP_HEADER: 'cloudfront-viewer-address',
    });
    expect(
      resolveClientAddress({ socket, forwardedFor: '6.6.6.6', viewer: '198.51.100.10:46532' }, cf),
    ).toEqual({ address: '198.51.100.10', chainInvalid: false });
    expect(
      resolveClientAddress({ socket, forwardedFor: '6.6.6.6', viewer: '2001:db8::7:46532' }, cf),
    ).toEqual({ address: '2001:db8::7', chainInvalid: false });
    expect(
      resolveClientAddress({ socket, forwardedFor: '198.51.100.3', viewer: 'garbage' }, cf),
    ).toEqual({ address: '198.51.100.3', chainInvalid: true });
    const plain = config({ DREFYN_TRUSTED_PROXY_HOPS: '1' });
    expect(
      resolveClientAddress(
        { socket, forwardedFor: '198.51.100.3', viewer: '198.51.100.10:46532' },
        plain,
      ),
    ).toEqual({ address: '198.51.100.3', chainInvalid: false });
  });

  const ip = fc.oneof(fc.ipV4(), fc.ipV6());
  const entry = fc.oneof(ip, fc.string({ maxLength: 12 }), fc.constant(''));

  it('always resolves to the socket or an address a trusted hop wrote', () => {
    fc.assert(
      fc.property(
        fc.ipV4(),
        fc.array(entry, { maxLength: 8 }),
        fc.array(ip, { maxLength: 4 }),
        fc.integer({ min: 0, max: 4 }),
        (sock, clientPart, proxyPart, hops) => {
          // What the client sent, then what each trusted proxy appended.
          const chain = [...clientPart, ...proxyPart];
          const forwardedFor = chain.length === 0 ? undefined : chain.join(', ');
          const resolved = resolveClientAddress(
            { socket: sock, forwardedFor, viewer: undefined },
            config({ DREFYN_TRUSTED_PROXY_HOPS: String(hops) }),
          );
          const parts =
            forwardedFor === undefined ? [] : forwardedFor.split(',').map((p) => p.trim());
          const all = [...parts, sock];
          // Entries a trusted hop can vouch for: the socket and the hops entries left of it.
          const trusted = all.slice(Math.max(0, all.length - 1 - hops));
          expect(trusted).toContain(resolved.address);
          expect(parseIp(resolved.address)).not.toBeNull();
        },
      ),
      { seed: 142, numRuns: 500 },
    );
  });
});

describe('header rewriting', () => {
  const headers = (): IncomingHttpHeaders => ({
    host: 'app.drefyn.test',
    'x-forwarded-for': '6.6.6.6',
    forwarded: 'for=6.6.6.6',
    'x-real-ip': '6.6.6.6',
    'cf-connecting-ip': '6.6.6.6',
    'true-client-ip': '6.6.6.6',
    'cloudfront-viewer-address': '6.6.6.6:1',
    'x-forwarded-host': 'evil.example',
    'x-forwarded-proto': 'http',
    'x-forwarded-port': '8080',
    accept: 'text/html',
  });

  it('removes every forwarding header and sets exactly the resolved address and the origin', () => {
    const h = headers();
    rewriteHeaders(h, config(), '192.0.2.50');
    expect(h).toEqual({
      host: 'app.drefyn.test',
      'x-forwarded-for': '192.0.2.50',
      'x-forwarded-host': 'app.drefyn.test',
      'x-forwarded-proto': 'https',
      'x-forwarded-port': '443',
      accept: 'text/html',
    });
    expect(FORWARDING_HEADERS).toEqual([
      'x-forwarded-for',
      'forwarded',
      'x-real-ip',
      'cf-connecting-ip',
      'true-client-ip',
      'cloudfront-viewer-address',
    ]);
  });

  it('matches the Host only to the origin host', () => {
    const c = config();
    expect(hostMatches('app.drefyn.test', c)).toBe(true);
    expect(hostMatches('APP.drefyn.test', c)).toBe(true);
    expect(hostMatches('app.drefyn.test:443', c)).toBe(true);
    for (const host of [
      undefined,
      '',
      'evil.example',
      'app.drefyn.test:8443',
      'app.drefyn.test.',
      'x.app.drefyn.test',
    ]) {
      expect(hostMatches(host, c), String(host)).toBe(false);
    }
    const local = parseWrapperConfig({ DREFYN_APP_ORIGIN: 'http://localhost:3000' });
    expect(hostMatches('localhost:3000', local)).toBe(true);
    expect(hostMatches('localhost', local)).toBe(false);
  });
});

describe('the throttle', () => {
  it('lets one event through per minute on the given clock', () => {
    let now = 1_000_000;
    const allow = createThrottle(() => now);
    expect(allow()).toBe(true);
    now += 59_999;
    expect(allow()).toBe(false);
    now += 1;
    expect(allow()).toBe(true);
    expect(allow()).toBe(false);
  });
});

interface Sent {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function request(
  headers: IncomingHttpHeaders,
  url = '/',
  remoteAddress: string | undefined = '192.0.2.50',
) {
  return { headers, url, method: 'GET', socket: { remoteAddress } } as unknown as IncomingMessage;
}

function response() {
  const sent: Sent = { status: 200, headers: {}, body: '' };
  const res = {
    set statusCode(code: number) {
      sent.status = code;
    },
    setHeader(name: string, value: string) {
      sent.headers[name.toLowerCase()] = value;
    },
    end(body = '') {
      sent.body = body;
    },
  } as unknown as ServerResponse;
  return { res, sent };
}

function wrapper(c: WrapperConfig = config(), now = () => 0) {
  const handle = vi.fn();
  const warn = vi.fn();
  const serve = createWrapper({ config: c, handle, warn, now });
  return { serve, handle, warn };
}

describe('the wrapper', () => {
  it('answers 421 to a Host that is not the origin host, and never calls Next', () => {
    const { serve, handle } = wrapper();
    const { res, sent } = response();
    serve(request({ host: 'evil.example' }), res);
    expect(sent.status).toBe(421);
    expect(sent.headers['cache-control']).toBe('no-store');
    expect(handle).not.toHaveBeenCalled();
  });

  it('answers the health check on the loopback host without calling Next', () => {
    const { serve, handle } = wrapper();
    for (const host of ['127.0.0.1:3000', 'localhost:3000', '[::1]:3000']) {
      const { res, sent } = response();
      serve(request({ host }, HEALTH_PATH, '127.0.0.1'), res);
      expect(sent.status, host).toBe(200);
      expect(sent.body).toBe('ok\n');
    }
    const { res, sent } = response();
    serve(request({ host: '127.0.0.1:3000' }, '/'), res);
    expect(sent.status).toBe(421);
    expect(handle).not.toHaveBeenCalled();
  });

  it('answers 400 when the socket has no address left, and never calls Next', () => {
    const { serve, handle } = wrapper();
    const { res, sent } = response();
    serve(request({ host: 'app.drefyn.test' }, '/', undefined), res);
    expect(sent.status).toBe(400);
    expect(handle).not.toHaveBeenCalled();
  });

  it('hands Next the rewritten headers', () => {
    const { serve, handle } = wrapper(config({ DREFYN_TRUSTED_PROXY_HOPS: '1' }));
    const req = request({
      host: 'app.drefyn.test',
      'x-forwarded-for': '6.6.6.6, 198.51.100.7',
      'x-forwarded-host': 'evil.example',
    });
    const { res } = response();
    serve(req, res);
    expect(handle).toHaveBeenCalledWith(req, res);
    expect(req.headers['x-forwarded-for']).toBe('198.51.100.7');
    expect(req.headers['x-forwarded-host']).toBe('app.drefyn.test');
  });

  it('with 0 hops, warns about forwarding headers at most once a minute', () => {
    let now = 0;
    const { serve, warn } = wrapper(config(), () => now);
    const hit = () =>
      serve(request({ host: 'app.drefyn.test', 'x-forwarded-for': '6.6.6.6' }), response().res);
    hit();
    hit();
    now += 30_000;
    hit();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('auth.forwarded_header_ignored', { hops: 0 });
    now += 30_000;
    hit();
    expect(warn).toHaveBeenCalledTimes(2);
    serve(request({ host: 'app.drefyn.test' }), response().res);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('logs auth.client_ip_chain_invalid for a short chain, at most once a minute', () => {
    const { serve, warn } = wrapper(config({ DREFYN_TRUSTED_PROXY_HOPS: '2' }));
    serve(request({ host: 'app.drefyn.test' }), response().res);
    serve(request({ host: 'app.drefyn.test' }), response().res);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('auth.client_ip_chain_invalid', { hops: 2 });
  });
});
