import type { TokenUsage } from '@drefyn/credits';
import { z } from 'zod';
import {
  badOutput,
  createAdapter,
  parseJson,
  refused,
  type AdapterOptions,
  type Read,
  type WireFormat,
} from './call.ts';
import type { ModelDeps, ModelProvider, ModelRequest } from './types.ts';

export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5-5';
const API_VERSION = '2023-06-01';

const count = z.int().min(0);
const optionalCount = count.nullish();

const usageSchema = z.object({
  input_tokens: count,
  output_tokens: count,
  cache_creation_input_tokens: optionalCount,
  cache_read_input_tokens: optionalCount,
  cache_creation: z
    .object({
      ephemeral_5m_input_tokens: optionalCount,
      ephemeral_1h_input_tokens: optionalCount,
    })
    .nullish(),
});

const messageSchema = z.object({
  content: z.array(z.unknown()),
  stop_reason: z.string(),
  usage: z.unknown().optional(),
});

const textBlock = z.object({ type: z.literal('text'), text: z.string() });

// Usage we cannot trust is dropped whole, so settlement keeps the hold instead of
// charging a count a provider made up.
function usageOf(value: unknown): TokenUsage | undefined {
  const parsed = usageSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const usage = parsed.data;
  // Without the split, every cache write is priced at the five minute rate, the cheaper
  // one, so a missing field can never raise a charge.
  const split = usage.cache_creation;
  return {
    input: usage.input_tokens,
    cacheWrite5m:
      split === null || split === undefined
        ? (usage.cache_creation_input_tokens ?? 0)
        : (split.ephemeral_5m_input_tokens ?? 0),
    cacheWrite1h:
      split === null || split === undefined ? 0 : (split.ephemeral_1h_input_tokens ?? 0),
    cacheRead: usage.cache_read_input_tokens ?? 0,
    output: usage.output_tokens,
  };
}

export function readAnthropicAnswer(body: Uint8Array): Read {
  const parsed = messageSchema.safeParse(parseJson(body));
  if (!parsed.success) return badOutput('malformed');
  const message = parsed.data;
  let text = '';
  for (const block of message.content) {
    const type: unknown =
      typeof block === 'object' && block !== null ? Reflect.get(block, 'type') : undefined;
    if (type !== 'text') continue;
    const checked = textBlock.safeParse(block);
    if (!checked.success) return badOutput('malformed');
    text += checked.data.text;
  }
  const usage = usageOf(message.usage);
  switch (message.stop_reason) {
    case 'refusal':
      return refused('refusal');
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return { ok: true, value: { text, stopReason: 'max_tokens', usage } };
    case 'end_turn':
    case 'stop_sequence':
      if (text === '') return badOutput('empty');
      return { ok: true, value: { text, stopReason: 'end', usage } };
    default:
      return badOutput('unexpected_stop');
  }
}

function body(request: ModelRequest, model: string): unknown {
  const system =
    request.system === undefined
      ? {}
      : {
          system: [
            {
              type: 'text',
              text: request.system,
              ...(request.cacheSystem === true ? { cache_control: { type: 'ephemeral' } } : {}),
            },
          ],
        };
  return {
    model,
    max_tokens: request.maxOutputTokens,
    ...system,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: [{ type: 'text', text: message.text }],
    })),
  };
}

const anthropic: WireFormat = {
  kind: 'anthropic',
  path: '/v1/messages',
  headers: (key) => {
    if (key === undefined) throw new TypeError('ai: the Anthropic adapter needs a key');
    return {
      'content-type': 'application/json',
      accept: 'application/json',
      'accept-encoding': 'identity',
      'anthropic-version': API_VERSION,
      'x-api-key': key.reveal(),
    };
  },
  body,
  read: readAnthropicAnswer,
};

/** The Anthropic Messages API, one buffered call per request, through @drefyn/egress. */
export function createAnthropicProvider(options: AdapterOptions, deps: ModelDeps): ModelProvider {
  return createAdapter(anthropic, options, deps);
}
