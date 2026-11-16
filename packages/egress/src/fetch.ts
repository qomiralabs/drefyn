import { request as httpRequest, validateHeaderName, validateHeaderValue } from 'node:http';
import type { Socket } from 'node:net';
import { type Connection, dial, networkFailed } from './connect.ts';
import { Deadline } from './deadline.ts';
import { checkPolicy } from './policy.ts';
import { resolveHost } from './resolve.ts';
import type { Runtime } from './runtime.ts';
import { checkTarget, type Target } from './target.ts';
import type {
  EgressError,
  EgressPolicy,
  GuardedRequestInit,
  GuardedResponse,
  Result,
} from './types.ts';

// The guard writes these itself. A caller's Host could point the request at a name the
// check never saw, and the framing headers could split one request into two.
const OWNED_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'proxy-connection',
]);
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];
const BODY_HEADERS = ['content-type', 'content-encoding', 'content-language', 'content-location'];
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

interface Outgoing {
  readonly method: string;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: Buffer | undefined;
}

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
  readonly location: string | undefined;
}

const failure = (error: EgressError) => ({ ok: false, error }) as const;

function outgoing(init: GuardedRequestInit): Outgoing {
  const method = init.method ?? 'GET';
  if (!TOKEN.test(method)) throw new TypeError('egress: the method is not an HTTP token');
  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(init.headers ?? {})) {
    // Both throw a TypeError on a bad name or a value carrying CR, LF or NUL.
    validateHeaderName(name);
    validateHeaderValue(name, value);
    const lower = name.toLowerCase();
    if (!OWNED_HEADERS.has(lower)) headers.set(lower, value);
  }
  const body = init.body === undefined ? undefined : Buffer.from(init.body);
  return { method, headers, body };
}

// What fetch does on a redirect: 303 and a POST on 301 or 302 become a GET without a
// body, and credentials stay behind when the redirect leaves the origin.
function redirected(previous: Outgoing, status: number, crossOrigin: boolean): Outgoing {
  const toGet =
    (status === 303 && previous.method !== 'HEAD') ||
    ((status === 301 || status === 302) && previous.method === 'POST');
  const headers = new Map(previous.headers);
  if (toGet) for (const name of BODY_HEADERS) headers.delete(name);
  if (crossOrigin) for (const name of CREDENTIAL_HEADERS) headers.delete(name);
  return {
    method: toGet ? 'GET' : previous.method,
    headers,
    body: toGet ? undefined : previous.body,
  };
}

function exchange(
  connection: Connection,
  target: Target,
  out: Outgoing,
  policy: EgressPolicy,
  deadline: Deadline,
  hop: number,
): Promise<Result<Answer, EgressError>> {
  return new Promise((resolve) => {
    const socket: Socket = connection.socket;
    let done = false;
    const finish = (result: Result<Answer, EgressError>) => {
      if (done) return;
      done = true;
      unwatch();
      // One request per connection, so a pooled socket can never skip a fresh check.
      socket.on('error', () => undefined);
      socket.destroy();
      resolve(result);
    };
    const unwatch = deadline.watch(() => {
      finish(failure({ code: deadline.code, hop }));
    });
    const headers: Record<string, string> = {
      ...Object.fromEntries(out.headers),
      host: target.url.host,
      connection: 'close',
      ...(out.body === undefined ? {} : { 'content-length': String(out.body.byteLength) }),
    };
    const req = httpRequest({
      method: out.method,
      path: `${target.url.pathname}${target.url.search}`,
      headers,
      setHost: false,
      createConnection: () => socket,
    });
    req.on('error', (error) => {
      finish(failure(networkFailed(error, hop)));
    });
    req.on('response', (res) => {
      const status = res.statusCode ?? 0;
      const answerHeaders = new Headers();
      for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
        answerHeaders.append(res.rawHeaders[i] ?? '', res.rawHeaders[i + 1] ?? '');
      }
      const location = res.headers.location;
      if (REDIRECTS.has(status) && location !== undefined) {
        finish({
          ok: true,
          value: { status, headers: answerHeaders, body: new Uint8Array(), location },
        });
        return;
      }
      const declared = Number(res.headers['content-length'] ?? 0);
      if (declared > policy.maxResponseBytes) {
        finish(failure({ code: 'egress.too_large', hop }));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > policy.maxResponseBytes) {
          finish(failure({ code: 'egress.too_large', hop }));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const body = new Uint8Array(Buffer.concat(chunks));
        finish({ ok: true, value: { status, headers: answerHeaders, body, location: undefined } });
      });
      res.on('error', (error) => {
        finish(failure(networkFailed(error, hop)));
      });
      res.on('close', () => {
        if (!res.complete) finish(failure(networkFailed({ code: 'ECONNRESET' }, hop)));
      });
    });
    req.end(out.body);
  });
}

export async function guardedFetchWith(
  runtime: Runtime,
  url: string,
  init: GuardedRequestInit,
  policy: EgressPolicy,
): Promise<Result<GuardedResponse, EgressError>> {
  checkPolicy(policy);
  let out = outgoing(init);
  const deadline = new Deadline(policy.totalTimeoutMs, init.signal);
  try {
    let current = url;
    for (let hop = 0; ; hop += 1) {
      if (hop > policy.maxRedirects) return failure({ code: 'egress.too_many_redirects', hop });
      if (deadline.signal.aborted) return failure({ code: deadline.code, hop });
      const target = checkTarget(current, policy, hop);
      if (!target.ok) return target;
      const addresses = await resolveHost(runtime, target.value, policy, deadline, hop);
      if (!addresses.ok) return addresses;
      const tls = target.value.tls
        ? {
            servername: target.value.literal === undefined ? target.value.host : undefined,
            identity: target.value.host,
          }
        : undefined;
      const connection = await dial(
        runtime,
        addresses.value,
        target.value.port,
        tls,
        policy,
        deadline,
        hop,
      );
      if (!connection.ok) return connection;
      const answer = await exchange(connection.value, target.value, out, policy, deadline, hop);
      if (!answer.ok) return answer;
      const { status, headers, body, location } = answer.value;
      if (location === undefined) {
        return {
          ok: true,
          value: {
            status,
            headers,
            body,
            url: target.value.url.href,
            redirects: hop,
            address: connection.value.address,
          },
        };
      }
      const next = URL.parse(location, target.value.url.href);
      if (next === null) return failure({ code: 'egress.url_invalid', hop: hop + 1 });
      out = redirected(out, status, next.origin !== target.value.url.origin);
      current = next.href;
    }
  } finally {
    deadline.dispose();
  }
}
