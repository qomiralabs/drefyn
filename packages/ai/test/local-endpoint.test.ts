import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createModelProvider, loadModelConfig } from '../src/index.ts';
import { openAiCompletion, startFakeProvider, type FakeProvider } from './support/fake-provider.ts';
import { ANSWER, PROMPT, signal, TENANT, testDeps } from './support/harness.ts';

// The self host path: an operator points the four settings at a model on their own
// machine, with no key and nothing paid, and a feature gets an answer.

let fake: FakeProvider;

beforeAll(async () => {
  fake = await startFakeProvider();
});

afterAll(async () => {
  await fake.close();
});

describe('a local OpenAI compatible endpoint', () => {
  it('answers from the environment settings alone, with no key and no key file', async () => {
    let keyReads = 0;
    const config = await loadModelConfig(
      {
        DREFYN_MODEL_PROVIDER: 'openai_compatible',
        DREFYN_MODEL_BASE_URL: `${fake.origin}/v1`,
        DREFYN_MODEL_NAME: 'llama3.1:8b',
        DREFYN_MODEL_ALLOW_PRIVATE_CIDRS: '127.0.0.0/8',
      },
      () => {
        keyReads += 1;
        return Promise.resolve('');
      },
    );
    fake.reply(openAiCompletion(ANSWER, { usage: null }));
    const deps = testDeps();
    const provider = createModelProvider(config, deps);
    const result = await provider.complete(
      { tenant: TENANT, messages: [{ role: 'user', text: PROMPT }], maxOutputTokens: 256 },
      signal(),
    );
    expect(keyReads).toBe(0);
    expect(result).toEqual({
      ok: true,
      value: {
        text: ANSWER,
        model: 'llama3.1:8b',
        stopReason: 'end',
        usage: undefined,
        attempts: 1,
      },
    });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.headers['authorization']).toBeUndefined();
    expect(fake.requests[0]?.body).toEqual({
      model: 'llama3.1:8b',
      max_tokens: 256,
      stream: false,
      messages: [{ role: 'user', content: PROMPT }],
    });
  });
});
