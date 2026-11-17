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

const count = z.int().min(0);

const usageSchema = z.object({
  prompt_tokens: count,
  completion_tokens: count,
  prompt_tokens_details: z.object({ cached_tokens: count.nullish() }).nullish(),
});

const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
          refusal: z.string().nullish(),
        }),
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
  usage: z.unknown().optional(),
});

function usageOf(value: unknown): TokenUsage | undefined {
  const parsed = usageSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { prompt_tokens: prompt, completion_tokens: output } = parsed.data;
  const cached = parsed.data.prompt_tokens_details?.cached_tokens ?? 0;
  // Cached tokens are part of the prompt count; more cached than sent is not a count.
  if (cached > prompt) return undefined;
  return { input: prompt - cached, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: cached, output };
}

export function readOpenAiAnswer(body: Uint8Array): Read {
  const parsed = completionSchema.safeParse(parseJson(body));
  if (!parsed.success) return badOutput('malformed');
  const [choice] = parsed.data.choices;
  if (choice === undefined) return badOutput('malformed');
  const refusal = choice.message.refusal;
  if (refusal !== null && refusal !== undefined && refusal !== '') return refused('refusal');
  const text = choice.message.content ?? '';
  const usage = usageOf(parsed.data.usage);
  switch (choice.finish_reason) {
    case 'content_filter':
      return refused('content_filter');
    case 'length':
      return { ok: true, value: { text, stopReason: 'max_tokens', usage } };
    // Some local servers leave the reason out of a finished answer.
    case 'stop':
    case null:
    case undefined:
      if (text === '') return badOutput('empty');
      return { ok: true, value: { text, stopReason: 'end', usage } };
    default:
      return badOutput('unexpected_stop');
  }
}

function body(request: ModelRequest, model: string): unknown {
  const system = request.system === undefined ? [] : [{ role: 'system', content: request.system }];
  return {
    model,
    // max_tokens rather than max_completion_tokens: it is the one local servers all read.
    max_tokens: request.maxOutputTokens,
    stream: false,
    messages: [
      ...system,
      ...request.messages.map((message) => ({ role: message.role, content: message.text })),
    ],
  };
}

const openAiCompatible: WireFormat = {
  kind: 'openai_compatible',
  path: '/chat/completions',
  headers: (key) => ({
    'content-type': 'application/json',
    accept: 'application/json',
    'accept-encoding': 'identity',
    ...(key === undefined ? {} : { authorization: `Bearer ${key.reveal()}` }),
  }),
  body,
  read: readOpenAiAnswer,
};

/**
 * Any endpoint that speaks OpenAI chat completions: a hosted gateway, or a model on the
 * operator's own machine with no key at all.
 */
export function createOpenAiCompatibleProvider(
  options: AdapterOptions,
  deps: ModelDeps,
): ModelProvider {
  return createAdapter(openAiCompatible, options, deps);
}
