import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { readAnthropicAnswer } from '../src/anthropic.ts';
import { readOpenAiAnswer } from '../src/openai.ts';

// Provider answers are untrusted input. Whatever bytes come back, the readers return a
// typed outcome, never throw, and never hand credits a token count that is not a
// non negative safe integer.

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

const READERS = [
  ['anthropic', readAnthropicAnswer],
  ['openai_compatible', readOpenAiAnswer],
] as const;

const OUTCOME_CODES = new Set(['model.bad_output', 'model.refused']);

function checkOutcome(outcome: ReturnType<typeof readAnthropicAnswer>): void {
  if (outcome.ok) {
    expect(typeof outcome.value.text).toBe('string');
    expect(['end', 'max_tokens']).toContain(outcome.value.stopReason);
    if (outcome.value.usage !== undefined) {
      for (const count of Object.values(outcome.value.usage)) {
        expect(Number.isSafeInteger(count) && count >= 0).toBe(true);
      }
    }
  } else {
    expect(OUTCOME_CODES.has(outcome.error.code)).toBe(true);
  }
}

// Seen after a JSON round trip, as the reader sees it: NaN and the infinities become null.
const wire = (value: unknown): unknown =>
  value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown);

const count = fc
  .oneof(
    fc.nat(),
    fc.integer(),
    fc.double(),
    fc.constant(Number.MAX_SAFE_INTEGER + 1),
    fc.string(),
    fc.constant(null),
    fc.constant(undefined),
    fc.boolean(),
  )
  .map(wire);

describe.each(READERS)('%s reader', (_name, read) => {
  it('never throws on arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
        checkOutcome(read(bytes));
      }),
      { numRuns: 300 },
    );
  });

  it('never throws on arbitrary JSON', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        checkOutcome(read(encode(value)));
      }),
      { numRuns: 300 },
    );
  });
});

describe('Anthropic usage under hostile counts', () => {
  it('keeps valid counts exactly and drops the whole usage otherwise', () => {
    fc.assert(
      fc.property(
        fc.string(),
        count,
        count,
        count,
        count,
        fc.option(
          fc.record({ ephemeral_5m_input_tokens: count, ephemeral_1h_input_tokens: count }),
          {
            nil: undefined,
          },
        ),
        (text, input, output, write, read, breakdown) => {
          const outcome = readAnthropicAnswer(
            encode({
              type: 'message',
              model: 'claude-sonnet-5-5',
              content: [{ type: 'text', text: `x${text}` }],
              stop_reason: 'end_turn',
              usage: {
                input_tokens: input,
                output_tokens: output,
                cache_creation_input_tokens: write,
                cache_read_input_tokens: read,
                ...(breakdown === undefined ? {} : { cache_creation: breakdown }),
              },
            }),
          );
          checkOutcome(outcome);
          expect(outcome.ok).toBe(true);
          if (!outcome.ok) return;
          expect(outcome.value.text).toBe(`x${text}`);
          const valid = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
          const optional = (v: unknown) => v === undefined || v === null || valid(v);
          const usable =
            valid(input) &&
            valid(output) &&
            optional(write) &&
            optional(read) &&
            (breakdown === undefined ||
              (optional(breakdown.ephemeral_5m_input_tokens) &&
                optional(breakdown.ephemeral_1h_input_tokens)));
          expect(outcome.value.usage !== undefined).toBe(usable);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('OpenAI compatible usage under hostile counts', () => {
  it('keeps valid counts exactly and drops the whole usage otherwise', () => {
    fc.assert(
      fc.property(fc.string(), count, count, count, (text, prompt, completion, cached) => {
        const outcome = readOpenAiAnswer(
          encode({
            model: 'm',
            choices: [
              { message: { role: 'assistant', content: `x${text}` }, finish_reason: 'stop' },
            ],
            usage: {
              prompt_tokens: prompt,
              completion_tokens: completion,
              prompt_tokens_details: { cached_tokens: cached },
            },
          }),
        );
        checkOutcome(outcome);
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.value.text).toBe(`x${text}`);
        const valid = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
        const cachedOk = cached === undefined || cached === null || valid(cached);
        const usable =
          valid(prompt) &&
          valid(completion) &&
          cachedOk &&
          (typeof cached !== 'number' || (prompt as number) >= cached);
        expect(outcome.value.usage !== undefined).toBe(usable);
        if (outcome.value.usage !== undefined) {
          const reads = typeof cached === 'number' ? cached : 0;
          expect(outcome.value.usage.input + outcome.value.usage.cacheRead).toBe(prompt);
          expect(outcome.value.usage.cacheRead).toBe(reads);
        }
      }),
      { numRuns: 500 },
    );
  });
});
