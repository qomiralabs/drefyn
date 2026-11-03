import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OAUTH_HOSTS,
  OAuthFetchRefused,
  createOAuthFetch,
  normalizeGitHubTokenError,
  type OAuthTransport,
} from '../src/oauth/fetch.ts';
import { recordingLogger } from './email-fixtures.ts';

const MIB = 1_048_576;
const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token';

const ok = (body: ConstructorParameters<typeof Response>[0] = '{}', init: ResponseInit = {}) =>
  new Response(body, { status: 200, headers: { 'content-type': 'application/json' }, ...init });

function guarded(
  provider: 'github' | 'google',
  transport: OAuthTransport = () => Promise.resolve(ok()),
  extra: { timeoutMs?: number; maxBytes?: number } = {},
) {
  const { logger, logs } = recordingLogger();
  const spy = vi.fn(transport);
  return { fetch: createOAuthFetch({ provider, logger, transport: spy, ...extra }), spy, logs };
}

async function refusal(work: Promise<unknown>) {
  const error = await work.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OAuthFetchRefused);
  return (error as OAuthFetchRefused).reason;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the host list', () => {
  it('is the four provider hosts, fixed in code', () => {
    expect(OAUTH_HOSTS).toEqual([
      'github.com',
      'api.github.com',
      'oauth2.googleapis.com',
      'www.googleapis.com',
    ]);
  });

  it.each([
    ['github', 'https://evil.example/login/oauth/access_token'],
    ['github', 'https://github.com.evil.example/'],
    ['github', 'https://github.com:8443/login/oauth/access_token'],
    ['github', 'https://user:pass@github.com/login/oauth/access_token'],
    ['github', 'https://oauth2.googleapis.com/token'],
    ['google', 'https://api.github.com/user'],
    ['google', 'https://accounts.google.com/o/oauth2/v2/auth'],
    ['google', 'not a url'],
  ] as const)('%s refuses %s before any request', async (provider, url) => {
    const { fetch, spy, logs } = guarded(provider);
    expect(await refusal(fetch(url, {}))).toBe('host');
    expect(spy).not.toHaveBeenCalled();
    expect(logs).toEqual([
      { event: 'auth.oauth_fetch_refused', fields: { provider, reason: 'host' } },
    ]);
  });

  it('refuses plain http to a listed host', async () => {
    const { fetch, spy, logs } = guarded('github');
    expect(await refusal(fetch('http://github.com/login/oauth/access_token', {}))).toBe('scheme');
    expect(spy).not.toHaveBeenCalled();
    expect(logs[0]?.fields).toEqual({ provider: 'github', reason: 'scheme' });
  });

  it('sends a listed https request on with redirect error and a signal', async () => {
    const { fetch, spy } = guarded('google');
    const response = await fetch('https://www.googleapis.com/oauth2/v3/certs', {
      method: 'GET',
      redirect: 'manual',
    });
    expect(response.status).toBe(200);
    const init = spy.mock.calls[0]?.[1];
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(spy.mock.calls[0]?.[0]).toBe('https://www.googleapis.com/oauth2/v3/certs');
  });
});

describe('redirects', () => {
  it.each([301, 302, 303, 307, 308])('refuses a %i answer', async (status) => {
    const { fetch, logs } = guarded('github', () =>
      Promise.resolve(
        new Response(null, { status, headers: { location: 'https://evil.example/' } }),
      ),
    );
    expect(await refusal(fetch('https://api.github.com/user', {}))).toBe('redirect');
    expect(logs[0]?.fields).toEqual({ provider: 'github', reason: 'redirect' });
  });

  it('reports the platform refusing to follow one as a redirect', async () => {
    const { fetch } = guarded('github', () =>
      Promise.reject(new TypeError('fetch failed', { cause: new Error('unexpected redirect') })),
    );
    expect(await refusal(fetch('https://api.github.com/user', {}))).toBe('redirect');
  });

  it('passes any other transport failure through untouched', async () => {
    const failure = new TypeError('fetch failed', { cause: new Error('ECONNRESET') });
    const { fetch, logs } = guarded('github', () => Promise.reject(failure));
    await expect(fetch('https://api.github.com/user', {})).rejects.toBe(failure);
    expect(logs).toEqual([]);
  });
});

describe('the size cap', () => {
  it('passes exactly 1 MiB', async () => {
    const { fetch } = guarded('google', () => Promise.resolve(ok(new Uint8Array(MIB))));
    const response = await fetch('https://www.googleapis.com/oauth2/v3/certs', {});
    expect((await response.arrayBuffer()).byteLength).toBe(MIB);
  });

  it('refuses a body one byte over, streamed with no length', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MIB));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const { fetch, logs } = guarded('google', () => Promise.resolve(ok(stream)));
    expect(await refusal(fetch('https://www.googleapis.com/oauth2/v3/certs', {}))).toBe('size');
    expect(logs[0]?.fields).toEqual({ provider: 'google', reason: 'size' });
  });

  it('refuses a declared length over the cap and cancels the body unread', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const { fetch } = guarded('google', () =>
      Promise.resolve(ok(stream, { headers: { 'content-length': String(MIB + 1) } })),
    );
    expect(await refusal(fetch('https://oauth2.googleapis.com/token', {}))).toBe('size');
    expect(cancelled).toBe(true);
  });
});

describe('the deadline', () => {
  it('refuses a call that has not answered within 5 s', async () => {
    vi.useFakeTimers();
    const { fetch, logs } = guarded('github', (_url, init) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    });
    const pending = refusal(fetch('https://github.com/login/oauth/access_token', {}));
    await vi.advanceTimersByTimeAsync(4999);
    expect(logs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe('timeout');
    expect(logs[0]?.fields).toEqual({ provider: 'github', reason: 'timeout' });
  });

  it('counts the body against the same deadline', async () => {
    vi.useFakeTimers();
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4));
      },
    });
    const { fetch } = guarded('google', () => Promise.resolve(ok(stalled)));
    const pending = refusal(fetch('https://www.googleapis.com/oauth2/v3/certs', {}));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBe('timeout');
  });

  it('honours the caller’s own signal', async () => {
    const controller = new AbortController();
    const { fetch } = guarded('github', (_url, init) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new Error('caller aborted'));
        });
      });
    });
    const pending = fetch('https://api.github.com/user', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow('caller aborted');
  });
});

describe('the default transport', () => {
  it('is the global fetch, called directly with redirect error', async () => {
    const global = vi.fn(() => Promise.resolve(ok('{"ok":true}')));
    vi.stubGlobal('fetch', global);
    const { logger } = recordingLogger();
    const fetch = createOAuthFetch({ provider: 'github', logger });
    const response = await fetch('https://api.github.com/user', { method: 'GET' });
    expect(await response.json()).toEqual({ ok: true });
    expect(global).toHaveBeenCalledTimes(1);
    const calls = global.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]?.[1].redirect).toBe('error');
  });
});

describe('the GitHub token error shim', () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it('turns a 200 with error and no access_token into a 400 with identical bytes', async () => {
    const text = '{"error":"bad_verification_code","error_description":"x","error_uri":"y"}';
    const { fetch } = guarded('github', () => Promise.resolve(ok(text)));
    const response = await fetch(GITHUB_TOKEN, { method: 'POST' });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(text);
    expect(response.headers.get('content-type')).toBe('application/json');
  });

  it('passes a 200 with an access_token through untouched', async () => {
    const text = '{"access_token":"gho_x","token_type":"bearer","scope":""}';
    const { fetch } = guarded('github', () => Promise.resolve(ok(text)));
    const response = await fetch(GITHUB_TOKEN, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(text);
  });

  it('passes a 200 with both through, for the library to refuse', () => {
    const body = bytes('{"error":"x","access_token":"gho_x"}');
    const original = ok(body);
    expect(normalizeGitHubTokenError(original, body)).toBe(original);
  });

  it.each([
    ['a non string error', '{"error":1}'],
    ['a body that is not JSON', 'error=bad_verification_code'],
    ['a JSON array', '["error"]'],
  ])('leaves %s alone', (_name, text) => {
    const body = bytes(text);
    const original = ok(body);
    expect(normalizeGitHubTokenError(original, body)).toBe(original);
  });

  it('leaves a non 200 alone', () => {
    const body = bytes('{"error":"x"}');
    const original = new Response(body, { status: 404 });
    expect(normalizeGitHubTokenError(original, body)).toBe(original);
  });

  it('never touches any other URL', async () => {
    const text = '{"error":"bad_verification_code"}';
    for (const url of [
      'https://api.github.com/user',
      'https://github.com/login/oauth/access_token/x',
    ]) {
      const { fetch } = guarded('github', () => Promise.resolve(ok(text)));
      expect((await fetch(url, {})).status, url).toBe(200);
    }
    const { fetch } = guarded('google', () => Promise.resolve(ok(text)));
    expect((await fetch('https://oauth2.googleapis.com/token', {})).status).toBe(200);
  });
});

describe('what a refusal logs', () => {
  it('names the provider and reason only, never the URL', async () => {
    const { fetch, logs } = guarded('github');
    await refusal(fetch('https://evil.example/?code=abc&state=def', {}));
    expect(JSON.stringify(logs)).not.toContain('evil');
    expect(JSON.stringify(logs)).not.toContain('abc');
  });

  it('never fails because the logger does', async () => {
    const fetch = createOAuthFetch({
      provider: 'github',
      logger: {
        warn() {
          throw new Error('logger down');
        },
      },
      transport: () => Promise.resolve(ok()),
    });
    expect(await refusal(fetch('http://github.com/', {}))).toBe('scheme');
  });
});
