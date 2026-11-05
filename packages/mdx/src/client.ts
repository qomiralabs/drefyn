import type { TenantRef } from '@drefyn/tenancy';
import { z } from 'zod';
import { DEFAULT_LIMITS } from './policy.ts';
import { refused, wireResultSchema } from './result.ts';
import type { IsolatedPolicy } from './thread.ts';
import type { Dialect, ParseResult } from './types.ts';
import type { WireRequest } from './wire.ts';

export interface ParseClientRequest {
  readonly tenant: TenantRef;
  // Logged by the host, so it never holds page text.
  readonly path: string;
  readonly source: string;
  readonly dialect: Dialect;
  readonly policy: IsolatedPolicy;
}

export interface ParseClient {
  // Never parses here, and has no fallback that does. Resolves with a refusal for anything
  // about the page, the load or the host, so a save keeps its last good version.
  parse(request: ParseClientRequest): Promise<ParseResult>;
}

export interface ParseClientConfig {
  readonly url: string;
  readonly timeoutMs?: number;
  readonly maxAnswerBytes?: number;
  readonly fetch?: typeof globalThis.fetch;
}

const configSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  // Covers a full queue ahead of the page and its own kill.
  timeoutMs: z.int().min(1).max(600_000).default(60_000),
  maxAnswerBytes: z
    .int()
    .min(1)
    .default(64 * DEFAULT_LIMITS.maxBytes),
});

const BUSY = 429;

async function readCapped(response: Response, cap: number): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (reader === undefined) return undefined;
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    const chunk = read.value as Uint8Array;
    bytes += chunk.byteLength;
    if (bytes > cap) {
      await reader.cancel();
      return undefined;
    }
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

function readAnswer(text: string | undefined): ParseResult {
  if (text === undefined) return refused('mdx.parse_failed');
  try {
    const answer = wireResultSchema.safeParse(JSON.parse(text));
    return answer.success ? answer.data : refused('mdx.parse_failed');
  } catch {
    return refused('mdx.parse_failed');
  }
}

export function createParseClient(config: ParseClientConfig): ParseClient {
  const { url, timeoutMs, maxAnswerBytes } = configSchema.parse(config);
  const send = config.fetch ?? fetch;
  const endpoint = new URL('/parse', url);

  return {
    async parse(request) {
      const { tenant, path, source, dialect, policy } = request;
      if (Buffer.byteLength(source, 'utf8') > policy.limits.maxBytes) {
        return refused('mdx.too_large');
      }
      const frame: WireRequest = {
        tenant,
        path,
        source,
        dialect,
        policy: {
          ...policy,
          components: [...policy.components],
          linkProtocols: [...policy.linkProtocols],
        },
      };
      try {
        const response = await send(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(frame),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.status !== 200 && response.status !== BUSY) {
          return refused('mdx.parse_unavailable');
        }
        return readAnswer(await readCapped(response, maxAnswerBytes));
      } catch {
        // Down, killed or slow: none of it is a verdict on the page.
        return refused('mdx.parse_unavailable');
      }
    },
  };
}
