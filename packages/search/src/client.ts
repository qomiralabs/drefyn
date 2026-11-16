// The only place this package opens a connection. The base URL is deployment config, never
// anything a reader sent, and every call has a deadline, a size cap on the answer and a bounded,
// jittered retry that only idempotent calls get.

export type UnavailableReason = 'timeout' | 'network' | 'server' | 'too_large' | 'bad_response';

// Typesense could not answer usefully. Carries a reason code and never the message underneath,
// which can hold a URL with a key in it.
export class SearchUnavailableError extends Error {
  readonly reason: UnavailableReason;
  readonly status: number | undefined;
  constructor(reason: UnavailableReason, status?: number) {
    super(`search unavailable: ${reason}`);
    this.name = 'SearchUnavailableError';
    this.reason = reason;
    this.status = status;
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface TypesenseClientOptions {
  // Where Typesense listens, http or https, with no path, query or credentials.
  readonly url: string;
  readonly timeoutMs?: number;
  // Total tries for an idempotent call, the first included.
  readonly attempts?: number;
  readonly maxResponseBytes?: number;
  readonly fetch?: FetchLike;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

export interface TypesenseCall {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly key: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly contentType?: string;
  // Safe to send twice. Only these are retried.
  readonly idempotent: boolean;
  // Overrides the client deadline for one call, such as a bulk import.
  readonly timeoutMs?: number;
}

export interface TypesenseAnswer {
  readonly status: number;
  readonly text: string;
}

export interface TypesenseClient {
  call(request: TypesenseCall): Promise<TypesenseAnswer>;
}

export const DEFAULT_TIMEOUT_MS = 2000;
export const DEFAULT_ATTEMPTS = 2;
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const BACKOFF_BASE_MS = 50;
const BACKOFF_CAP_MS = 500;

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export function parseTypesenseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RangeError('Typesense URL is not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RangeError('Typesense URL must be http or https');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new RangeError('Typesense URL must not carry credentials, a query or a fragment');
  }
  if (url.pathname !== '/') throw new RangeError('Typesense URL must not carry a path');
  return url.origin;
}

const positiveInt = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive integer`);
  return value;
};

async function readCapped(response: Response, cap: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > cap) {
    await response.body?.cancel();
    throw new SearchUnavailableError('too_large', response.status);
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk: { readonly done: boolean; readonly value?: unknown } = await reader.read();
    if (chunk.done) break;
    const value = chunk.value;
    if (!(value instanceof Uint8Array)) {
      await reader.cancel();
      throw new SearchUnavailableError('bad_response', response.status);
    }
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      throw new SearchUnavailableError('too_large', response.status);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const isTimeout = (error: unknown): boolean =>
  error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');

export function createTypesenseClient(options: TypesenseClientOptions): TypesenseClient {
  const origin = parseTypesenseUrl(options.url);
  const timeoutMs = positiveInt(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs');
  const attempts = positiveInt(options.attempts ?? DEFAULT_ATTEMPTS, 'attempts');
  const cap = positiveInt(
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    'maxResponseBytes',
  );
  const send = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;

  const once = async (request: TypesenseCall): Promise<TypesenseAnswer> => {
    const url = new URL(request.path, origin);
    if (url.origin !== origin) throw new RangeError('path left the Typesense origin');
    for (const [name, value] of Object.entries(request.query ?? {})) {
      url.searchParams.set(name, value);
    }
    const headers: Record<string, string> = { 'x-typesense-api-key': request.key };
    if (request.body !== undefined)
      headers['content-type'] = request.contentType ?? 'application/json';
    let response: Response;
    try {
      response = await send(url.href, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        redirect: 'error',
        signal: AbortSignal.timeout(request.timeoutMs ?? timeoutMs),
      });
    } catch (error) {
      throw new SearchUnavailableError(isTimeout(error) ? 'timeout' : 'network');
    }
    let text: string;
    try {
      text = await readCapped(response, cap);
    } catch (error) {
      if (error instanceof SearchUnavailableError) throw error;
      throw new SearchUnavailableError(isTimeout(error) ? 'timeout' : 'network', response.status);
    }
    if (response.status >= 500) throw new SearchUnavailableError('server', response.status);
    return { status: response.status, text };
  };

  return Object.freeze({
    async call(request: TypesenseCall): Promise<TypesenseAnswer> {
      const tries = request.idempotent ? attempts : 1;
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await once(request);
        } catch (error) {
          const retryable = error instanceof SearchUnavailableError && error.reason !== 'too_large';
          if (!retryable || attempt >= tries) throw error;
          // Full jitter, so callers that failed together do not come back together.
          const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
          await sleep(Math.floor(random() * ceiling));
        }
      }
    },
  });
}
