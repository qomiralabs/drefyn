import { describe, expect, it } from 'vitest';
import {
  createTypesenseClient,
  parseTypesenseUrl,
  SearchUnavailableError,
  type FetchLike,
  type TypesenseCall,
} from '../src/client.ts';

interface Seen {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeFetch(...steps: (Response | Error | (() => Promise<Response>))[]) {
  const seen: Seen[] = [];
  const fetch: FetchLike = (url, init) => {
    seen.push({ url, init });
    const step = steps.shift();
    if (step === undefined) return Promise.reject(new Error('no step left'));
    if (step instanceof Error) return Promise.reject(step);
    if (typeof step === 'function') return step();
    return Promise.resolve(step);
  };
  return { fetch, seen };
}

const GET: TypesenseCall = { method: 'GET', path: '/health', key: 'k', idempotent: true };
const POST: TypesenseCall = {
  method: 'POST',
  path: '/keys',
  key: 'k',
  body: '{}',
  idempotent: false,
};

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SearchUnavailableError) return error.reason;
    throw error;
  }
  return 'resolved';
}

describe('parseTypesenseUrl', () => {
  it('keeps the origin of an http or https URL', () => {
    expect(parseTypesenseUrl('http://typesense:8108')).toBe('http://typesense:8108');
    expect(parseTypesenseUrl('https://search.internal/')).toBe('https://search.internal');
  });

  it.each([
    'not a url',
    'ftp://typesense',
    'http://user:pass@typesense',
    'http://typesense/?x=1',
    'http://typesense/#a',
    'http://typesense/base',
  ])('refuses %s', (raw) => {
    expect(() => parseTypesenseUrl(raw)).toThrow(RangeError);
  });
});

describe('createTypesenseClient', () => {
  it('sends the key as a header, the query as parameters, no redirects and a deadline', async () => {
    const { fetch, seen } = fakeFetch(new Response('{"ok":true}', { status: 200 }));
    const client = createTypesenseClient({ url: 'http://ts:8108', fetch });
    const answer = await client.call({
      method: 'GET',
      path: '/collections/c/documents/search',
      key: 'scoped',
      query: { q: 'a&b', filter_by: 'x:=`y`' },
      idempotent: true,
    });
    expect(answer).toEqual({ status: 200, text: '{"ok":true}' });
    const [call] = seen;
    const url = new URL(call?.url ?? '');
    expect(url.origin).toBe('http://ts:8108');
    expect(url.searchParams.get('q')).toBe('a&b');
    expect(url.searchParams.get('filter_by')).toBe('x:=`y`');
    expect(call?.init.headers).toEqual({ 'x-typesense-api-key': 'scoped' });
    expect(call?.init.redirect).toBe('error');
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('sets a content type only when there is a body', async () => {
    const { fetch, seen } = fakeFetch(
      new Response('', { status: 201 }),
      new Response('', { status: 200 }),
    );
    const client = createTypesenseClient({ url: 'http://ts:8108', fetch });
    await client.call(POST);
    await client.call({ ...POST, contentType: 'text/plain' });
    expect(seen[0]?.init.headers).toEqual({
      'x-typesense-api-key': 'k',
      'content-type': 'application/json',
    });
    expect(seen[1]?.init.headers).toEqual({
      'x-typesense-api-key': 'k',
      'content-type': 'text/plain',
    });
    expect(seen[0]?.init.body).toBe('{}');
  });

  it('refuses a path that would leave the origin', async () => {
    const { fetch } = fakeFetch();
    const client = createTypesenseClient({ url: 'http://ts:8108', fetch });
    await expect(client.call({ ...GET, path: '//evil.example/x' })).rejects.toThrow(RangeError);
  });

  it('retries an idempotent call once with jittered backoff, then reports the outage', async () => {
    const sleeps: number[] = [];
    const { fetch, seen } = fakeFetch(new TypeError('refused'), new TypeError('refused'));
    const client = createTypesenseClient({
      url: 'http://ts:8108',
      fetch,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      random: () => 0.999,
    });
    expect(await reasonOf(client.call(GET))).toBe('network');
    expect(seen).toHaveLength(2);
    expect(sleeps).toEqual([49]);
  });

  it('recovers when the retry succeeds', async () => {
    const { fetch, seen } = fakeFetch(
      new Response('busy', { status: 503 }),
      new Response('ok', { status: 200 }),
    );
    const client = createTypesenseClient({
      url: 'http://ts:8108',
      fetch,
      sleep: () => Promise.resolve(),
    });
    expect(await client.call(GET)).toEqual({ status: 200, text: 'ok' });
    expect(seen).toHaveLength(2);
  });

  it('never retries a call that is not idempotent', async () => {
    const { fetch, seen } = fakeFetch(new Response('busy', { status: 502 }));
    const client = createTypesenseClient({
      url: 'http://ts:8108',
      fetch,
      sleep: () => Promise.resolve(),
    });
    expect(await reasonOf(client.call(POST))).toBe('server');
    expect(seen).toHaveLength(1);
  });

  it('bounds the backoff for any number of attempts', async () => {
    const sleeps: number[] = [];
    const errors = Array.from({ length: 8 }, () => new TypeError('down'));
    const { fetch } = fakeFetch(...errors);
    const client = createTypesenseClient({
      url: 'http://ts:8108',
      fetch,
      attempts: 8,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      random: () => 0.999,
    });
    expect(await reasonOf(client.call(GET))).toBe('network');
    expect(sleeps).toHaveLength(7);
    expect(Math.max(...sleeps)).toBeLessThan(500);
  });

  it('reports a timeout as timeout', async () => {
    const { fetch } = fakeFetch(() =>
      Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')),
    );
    const client = createTypesenseClient({ url: 'http://ts:8108', fetch, attempts: 1 });
    expect(await reasonOf(client.call(GET))).toBe('timeout');
  });

  it('really aborts a call that passes its deadline', async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error);
        });
      });
    const client = createTypesenseClient({
      url: 'http://ts:8108',
      fetch,
      timeoutMs: 20,
      attempts: 1,
    });
    expect(await reasonOf(client.call(GET))).toBe('timeout');
  });

  it('caps the answer by its declared length and by what actually arrives', async () => {
    const big = 'x'.repeat(64);
    const declared = new Response(big, { status: 200, headers: { 'content-length': '200' } });
    const streamed = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(big));
          controller.enqueue(new TextEncoder().encode(big));
          controller.close();
        },
      }),
      { status: 200 },
    );
    const { fetch, seen } = fakeFetch(declared, streamed);
    const client = createTypesenseClient({ url: 'http://ts:8108', fetch, maxResponseBytes: 100 });
    expect(await reasonOf(client.call(GET))).toBe('too_large');
    expect(await reasonOf(client.call(GET))).toBe('too_large');
    // Too large is not an outage a retry fixes.
    expect(seen).toHaveLength(2);
  });

  it('reports a body that breaks off as a network failure', async () => {
    const broken = new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new TypeError('socket hang up'));
        },
      }),
      { status: 200 },
    );
    const { fetch } = fakeFetch(broken);
    const client = createTypesenseClient({ url: 'http://ts:8108', fetch, attempts: 1 });
    expect(await reasonOf(client.call(GET))).toBe('network');
  });

  it('reports a body that streams something other than bytes as a bad response', async () => {
    // Response only takes byte streams in its types; Node passes through whatever the stream
    // yields, which is the case this guards.
    const stream = new ReadableStream<unknown>({
      start(controller) {
        controller.enqueue('text, not bytes');
        controller.close();
      },
    }) as ReadableStream<Uint8Array>;
    const odd = new Response(stream, { status: 200 });
    const { fetch } = fakeFetch(odd);
    const client = createTypesenseClient({ url: 'http://ts:8108', fetch, attempts: 1 });
    expect(await reasonOf(client.call(GET))).toBe('bad_response');
  });

  it('returns an empty body as empty text', async () => {
    const { fetch } = fakeFetch(new Response(null, { status: 204 }));
    const client = createTypesenseClient({ url: 'http://ts:8108', fetch });
    expect(await client.call(GET)).toEqual({ status: 204, text: '' });
  });

  it('passes client errors through for the caller to judge', async () => {
    const { fetch } = fakeFetch(new Response('{"message":"Not Found"}', { status: 404 }));
    const client = createTypesenseClient({ url: 'http://ts:8108', fetch });
    expect((await client.call(GET)).status).toBe(404);
  });

  it('refuses bad options', () => {
    for (const bad of [{ timeoutMs: 0 }, { attempts: 0 }, { maxResponseBytes: 1.5 }]) {
      expect(() => createTypesenseClient({ url: 'http://ts:8108', ...bad })).toThrow(RangeError);
    }
  });

  it('keeps the message free of anything but the reason', () => {
    const error = new SearchUnavailableError('server', 502);
    expect(error.message).toBe('search unavailable: server');
    expect(error.status).toBe(502);
  });
});
