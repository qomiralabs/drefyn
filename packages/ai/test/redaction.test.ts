import { inspect } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAnthropicProvider,
  createOpenAiCompatibleProvider,
  loadModelConfig,
  ModelConfigError,
  ModelKey,
  type ModelProvider,
  type ModelRequest,
} from '../src/index.ts';
import {
  anthropicError,
  anthropicMessage,
  openAiCompletion,
  openAiError,
  raw,
  reset,
  startFakeProvider,
  type FakeProvider,
  type Reply,
} from './support/fake-provider.ts';
import {
  ANSWER,
  HINT,
  KEY,
  LOOPBACK,
  PROMPT,
  signal,
  SYSTEM,
  TENANT,
  testDeps,
  type TestDeps,
} from './support/harness.ts';

let fake: FakeProvider;

beforeAll(async () => {
  fake = await startFakeProvider();
});

afterAll(async () => {
  await fake.close();
});

beforeEach(() => {
  fake.requests.length = 0;
});

const request: ModelRequest = {
  tenant: TENANT,
  system: SYSTEM,
  messages: [{ role: 'user', text: PROMPT }],
  maxOutputTokens: 800,
};

const providers = (deps: TestDeps): readonly [string, ModelProvider, string][] => [
  [
    'anthropic',
    createAnthropicProvider(
      {
        baseUrl: fake.origin,
        key: new ModelKey(KEY),
        model: 'claude-sonnet-5-5',
        allowPrivateCidrs: LOOPBACK,
      },
      deps,
    ),
    fake.origin,
  ],
  [
    'openai_compatible',
    createOpenAiCompatibleProvider(
      {
        baseUrl: `${fake.origin}/v1`,
        key: new ModelKey(KEY),
        model: 'llama3.1:8b',
        allowPrivateCidrs: LOOPBACK,
      },
      deps,
    ),
    fake.origin,
  ],
];

// A hostile or careless provider echoes what it was sent: the key, the prompt and the
// system text. None of it may come back out through a log, an error or a metric.
const echo = `${KEY} ${PROMPT} ${SYSTEM}`;
const scripts: Record<string, readonly Reply[]> = {
  anthropic: [
    anthropicMessage(ANSWER),
    anthropicMessage(ANSWER, { usage: null }),
    anthropicError(401, 'authentication_error', `invalid x-api-key ${echo}`),
    anthropicError(529, 'overloaded_error', echo),
    anthropicError(400, 'invalid_request_error', echo),
    anthropicMessage(echo, { stop: 'refusal' }),
    raw(200, echo),
    reset,
  ],
  openai_compatible: [
    openAiCompletion(ANSWER),
    openAiCompletion(ANSWER, { usage: null }),
    openAiError(401, 'invalid_api_key', `Incorrect API key provided: ${echo}`),
    openAiError(429, 'rate_limit', echo),
    openAiError(400, 'invalid_request', echo),
    openAiCompletion(null, { refusal: echo }),
    raw(200, echo),
    reset,
  ],
};

async function everyPath(deps: TestDeps) {
  const outcomes: unknown[] = [];
  for (const [kind, provider] of providers(deps)) {
    for (const reply of scripts[kind] ?? []) {
      fake.reply(reply);
      outcomes.push(await provider.complete(request, signal()));
    }
  }
  return outcomes;
}

describe('what leaves through logs, errors and metrics', () => {
  it('never carries the key, its hint, the prompt, the system text, the answer or the endpoint', async () => {
    const deps = testDeps();
    const outcomes = await everyPath(deps);
    const errors = outcomes.filter(
      (outcome) =>
        typeof outcome === 'object' && outcome !== null && Reflect.get(outcome, 'ok') === false,
    );
    expect(errors.length).toBeGreaterThan(8);
    const seen = [
      JSON.stringify(deps.logger.records),
      JSON.stringify(deps.metricsSeen),
      JSON.stringify(errors),
      inspect(errors, { depth: 10 }),
    ].join('\n');
    for (const secret of [KEY, HINT, PROMPT, SYSTEM, ANSWER, fake.origin, '127.0.0.1']) {
      expect(seen, secret).not.toContain(secret);
    }
  });

  it('puts the organization and project on every log line and every metric', async () => {
    const deps = testDeps();
    await everyPath(deps);
    expect(deps.logger.records.length).toBeGreaterThan(0);
    for (const record of deps.logger.records) {
      expect(record.fields['organizationId'], record.event).toBe(TENANT.organizationId);
      expect(record.fields['projectId'], record.event).toBe(TENANT.projectId);
    }
    expect(deps.metricsSeen.length).toBeGreaterThan(0);
    for (const metric of deps.metricsSeen) {
      expect(metric.labels['organizationId'], metric.name).toBe(TENANT.organizationId);
      expect(metric.labels['projectId'], metric.name).toBe(TENANT.projectId);
    }
  });

  it('logs a finished call with token counts, and a missing usage as its own warning', async () => {
    const deps = testDeps();
    const [, anthropic] = providers(deps)[0] ?? [];
    fake.reply(anthropicMessage(ANSWER));
    await anthropic?.complete(request, signal());
    fake.reply(anthropicMessage(ANSWER, { usage: null }));
    await anthropic?.complete(request, signal());
    expect(deps.logger.records.map((r) => [r.level, r.event])).toEqual([
      ['info', 'ai.model_call'],
      ['warn', 'ai.usage_missing'],
      ['info', 'ai.model_call'],
    ]);
    expect(deps.logger.records[0]?.fields).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      attempts: 1,
      stopReason: 'end',
      input: 1200,
      cacheWrite5m: 200,
      cacheWrite1h: 100,
      cacheRead: 900,
      output: 240,
    });
    expect(typeof deps.logger.records[0]?.fields['durationMs']).toBe('number');
  });

  it('logs each retry and the final failure with its code, cause and status', async () => {
    const deps = testDeps();
    const [, anthropic] = providers(deps)[0] ?? [];
    fake.reply(anthropicError(529, 'overloaded_error'));
    await anthropic?.complete(request, signal());
    expect(deps.logger.records.map((r) => r.event)).toEqual([
      'ai.model_call_retry',
      'ai.model_call_retry',
      'ai.model_call_failed',
    ]);
    expect(deps.logger.records[2]?.fields).toMatchObject({
      code: 'model.overloaded',
      cause: 'overloaded',
      status: 529,
      attempts: 3,
    });
  });

  it('works with no metrics sink', async () => {
    const deps = testDeps({}, { noMetrics: true });
    const p = createAnthropicProvider(
      {
        baseUrl: fake.origin,
        key: new ModelKey(KEY),
        model: 'claude-sonnet-5-5',
        allowPrivateCidrs: LOOPBACK,
      },
      deps,
    );
    fake.reply(anthropicMessage(ANSWER));
    expect((await p.complete(request, signal())).ok).toBe(true);
  });

  it('keeps a throwing logger or metrics sink from failing the call', async () => {
    const deps = testDeps({
      logger: {
        info: () => {
          throw new Error('sink down');
        },
        warn: () => {
          throw new Error('sink down');
        },
      },
      metrics: {
        increment: () => {
          throw new Error('sink down');
        },
        observe: () => {
          throw new Error('sink down');
        },
      },
    });
    const [, anthropic] = providers(deps)[0] ?? [];
    fake.reply(anthropicMessage(ANSWER));
    expect((await anthropic?.complete(request, signal()))?.ok).toBe(true);
  });
});

describe('the key object', () => {
  it('prints, serialises and inspects as redacted, and shows only its last four characters as a hint', () => {
    const key = new ModelKey(KEY);
    expect(String(key)).toBe('[redacted]');
    expect(JSON.stringify({ key })).toBe('{"key":"[redacted]"}');
    expect(inspect({ key })).not.toContain(KEY);
    expect(key.hint).toBe(HINT);
    expect(key.reveal()).toBe(KEY);
  });

  it('refuses a value that cannot be a key without saying what the value was', () => {
    for (const bad of ['', 'short', 'has space inside it', 'x'.repeat(513), 'tab\there123']) {
      let thrown: unknown;
      try {
        new ModelKey(bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, bad).toBeInstanceOf(TypeError);
      if (bad.length > 0) expect(String(thrown), bad).not.toContain(bad);
    }
  });

  it('keeps the key out of the provider object itself', async () => {
    const deps = testDeps();
    for (const [, provider] of providers(deps)) {
      expect(inspect(provider, { depth: 10, showHidden: true })).not.toContain(KEY);
      expect(JSON.stringify(provider)).not.toContain(KEY);
    }
    const config = await loadModelConfig(
      {
        DREFYN_MODEL_PROVIDER: 'anthropic',
        DREFYN_MODEL_KEY_FILE: '/run/secrets/model-key',
      },
      () => Promise.resolve(`${KEY}\n`),
    );
    expect(JSON.stringify(config)).not.toContain(KEY);
    expect(inspect(config, { depth: 10 })).not.toContain(KEY);
  });

  it('never puts a bad key file content in the config error', async () => {
    const content = 'not a key because it has spaces in it';
    const failure = await loadModelConfig(
      { DREFYN_MODEL_PROVIDER: 'anthropic', DREFYN_MODEL_KEY_FILE: '/k' },
      () => Promise.resolve(content),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelConfigError);
    expect(JSON.stringify(failure)).not.toContain(content);
    expect(String(failure)).not.toContain(content);
    expect(inspect(failure)).not.toContain(content);
  });
});
