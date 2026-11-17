import type { EgressError, EgressPolicy, GuardedResponse, Result } from '@drefyn/egress';
import type { GitHubTransport } from '../../src/index.ts';

export interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly policy: EgressPolicy;
  readonly signal: AbortSignal | undefined;
}

export type Answer =
  | {
      readonly status: number;
      readonly json?: unknown;
      readonly raw?: string;
      readonly headers?: Record<string, string>;
    }
  | { readonly error: EgressError['code'] };

export interface FakeTransport {
  readonly transport: GitHubTransport;
  readonly calls: Call[];
  // Answers in order; the last one repeats.
  answer(...answers: Answer[]): void;
}

const decoder = new TextDecoder();

export function fakeTransport(): FakeTransport {
  const calls: Call[] = [];
  let queue: Answer[] = [{ status: 404, json: { message: 'Not Found' } }];
  const transport: GitHubTransport = (url, init, policy) => {
    const body = init.body;
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: { ...init.headers },
      body: body === undefined ? '' : typeof body === 'string' ? body : decoder.decode(body),
      policy,
      signal: init.signal,
    });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next === undefined) throw new Error('no answer');
    if ('error' in next) {
      return Promise.resolve({ ok: false, error: { code: next.error, hop: 0 } });
    }
    const text = next.raw ?? (next.json === undefined ? '' : JSON.stringify(next.json));
    const response: GuardedResponse = {
      status: next.status,
      headers: new Headers(next.headers ?? {}),
      body: new TextEncoder().encode(text),
      url,
      redirects: 0,
      address: { address: '192.0.2.1', family: 4 },
    };
    const result: Result<GuardedResponse, EgressError> = { ok: true, value: response };
    return Promise.resolve(result);
  };
  return {
    transport,
    calls,
    answer: (...answers) => {
      queue = answers;
    },
  };
}
