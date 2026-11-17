import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

// A stand in for a model provider on 127.0.0.1. It speaks the Anthropic Messages and the
// OpenAI chat completions wire formats closely enough to exercise every mapping, and it
// never forwards anything: no test in this package may reach a real provider.

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export type Reply =
  | {
      readonly kind: 'json';
      readonly status: number;
      readonly body: unknown;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: 'raw';
      readonly status: number;
      readonly body: string | Uint8Array;
      readonly headers?: Readonly<Record<string, string>>;
    }
  // Holds the request open until the client goes away.
  | { readonly kind: 'hang' }
  // Drops the connection without an answer.
  | { readonly kind: 'reset' };

export interface FakeProvider {
  readonly origin: string;
  readonly requests: RecordedRequest[];
  // Replies are used in order; the last one repeats once the list runs out.
  reply(...replies: Reply[]): void;
  // Resolves once a held request's connection has closed.
  closedHeld(): Promise<number>;
  close(): Promise<void>;
}

const json = (status: number, body: unknown, headers?: Record<string, string>): Reply => ({
  kind: 'json',
  status,
  body,
  ...(headers === undefined ? {} : { headers }),
});

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function headersOf(request: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') out[name] = value;
    else if (Array.isArray(value)) out[name] = value.join(', ');
  }
  return out;
}

// A real provider refuses a streaming request it cannot answer here, so a client that
// asks for a stream gets a clear failure rather than a silent pass.
function streamed(body: unknown): boolean {
  return typeof body === 'object' && body !== null && Reflect.get(body, 'stream') === true;
}

export async function startFakeProvider(): Promise<FakeProvider> {
  const requests: RecordedRequest[] = [];
  let queue: Reply[] = [];
  let closedCount = 0;
  let waiters: (() => void)[] = [];

  const answer = (response: ServerResponse, reply: Reply, request: IncomingMessage): void => {
    switch (reply.kind) {
      case 'json': {
        const text = JSON.stringify(reply.body);
        response.writeHead(reply.status, {
          'content-type': 'application/json',
          ...reply.headers,
        });
        response.end(text);
        return;
      }
      case 'raw':
        response.writeHead(reply.status, reply.headers ?? {});
        response.end(reply.body);
        return;
      case 'hang':
        request.socket.on('close', () => {
          closedCount += 1;
          for (const wake of waiters) wake();
          waiters = [];
        });
        return;
      case 'reset':
        request.socket.destroy();
        return;
    }
  };

  const server: Server = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request);
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        headers: headersOf(request),
        body,
      });
      if (streamed(body)) {
        answer(
          response,
          json(400, {
            type: 'error',
            error: { type: 'invalid_request_error', message: 'streaming is not served here' },
          }),
          request,
        );
        return;
      }
      const next = queue.length > 1 ? queue.shift() : queue[0];
      answer(response, next ?? json(500, { error: 'no reply scripted' }), request);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    reply: (...replies) => {
      queue = replies;
    },
    closedHeld: () =>
      closedCount > 0
        ? Promise.resolve(closedCount)
        : new Promise((resolve) => {
            waiters.push(() => {
              resolve(closedCount);
            });
          }),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

// Wire format builders. Field names follow each provider's published API.

export interface AnthropicUsage {
  readonly input_tokens?: unknown;
  readonly output_tokens?: unknown;
  readonly cache_creation_input_tokens?: unknown;
  readonly cache_read_input_tokens?: unknown;
  readonly cache_creation?: unknown;
}

export function anthropicMessage(
  text: string,
  options: {
    readonly stop?: string;
    readonly usage?: AnthropicUsage | null;
    readonly model?: string;
    readonly extraBlocks?: readonly unknown[];
  } = {},
): Reply {
  const usage =
    options.usage === null
      ? {}
      : {
          usage: options.usage ?? {
            input_tokens: 1200,
            output_tokens: 240,
            cache_creation_input_tokens: 300,
            cache_read_input_tokens: 900,
            cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 100 },
          },
        };
  return json(200, {
    id: 'msg_01fake',
    type: 'message',
    role: 'assistant',
    model: options.model ?? 'claude-sonnet-5-5',
    content: [...(options.extraBlocks ?? []), { type: 'text', text }],
    stop_reason: options.stop ?? 'end_turn',
    stop_sequence: null,
    ...usage,
  });
}

export function anthropicError(
  status: number,
  type: string,
  message = 'fake provider error',
  headers?: Record<string, string>,
): Reply {
  return json(status, { type: 'error', error: { type, message } }, headers);
}

export function openAiCompletion(
  content: string | null,
  options: {
    readonly finish?: string | null;
    readonly usage?: unknown;
    readonly model?: string;
    readonly refusal?: string | null;
  } = {},
): Reply {
  const usage =
    options.usage === undefined
      ? {
          usage: {
            prompt_tokens: 1500,
            completion_tokens: 320,
            total_tokens: 1820,
            prompt_tokens_details: { cached_tokens: 500 },
          },
        }
      : options.usage === null
        ? {}
        : { usage: options.usage };
  return json(200, {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    created: 1_790_000_000,
    model: options.model ?? 'llama3.1:8b',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          ...(options.refusal === undefined ? {} : { refusal: options.refusal }),
        },
        finish_reason: options.finish === undefined ? 'stop' : options.finish,
      },
    ],
    ...usage,
  });
}

export function openAiError(
  status: number,
  type: string,
  message = 'fake provider error',
  headers?: Record<string, string>,
): Reply {
  return json(status, { error: { message, type, code: null } }, headers);
}

export const raw = (
  status: number,
  body: string | Uint8Array,
  headers?: Record<string, string>,
): Reply => ({ kind: 'raw', status, body, ...(headers === undefined ? {} : { headers }) });

export const hang: Reply = { kind: 'hang' };
export const reset: Reply = { kind: 'reset' };
