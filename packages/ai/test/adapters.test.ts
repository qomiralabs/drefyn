import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAnthropicProvider,
  createModelProvider,
  createOpenAiCompatibleProvider,
  MODEL_ERROR_CODES,
  ModelKey,
  type ModelProvider,
  type ModelRequest,
} from '../src/index.ts';
import {
  anthropicError,
  anthropicMessage,
  hang,
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

const request = (extra: Partial<ModelRequest> = {}): ModelRequest => ({
  tenant: TENANT,
  system: SYSTEM,
  messages: [{ role: 'user', text: PROMPT }],
  maxOutputTokens: 1500,
  ...extra,
});

type Kind = 'anthropic' | 'openai_compatible';

function provider(
  kind: Kind,
  deps: TestDeps,
  options: { timeoutMs?: number; maxAttempts?: number } = {},
): ModelProvider {
  if (kind === 'anthropic') {
    return createAnthropicProvider(
      {
        baseUrl: fake.origin,
        key: new ModelKey(KEY),
        model: 'claude-sonnet-5-5',
        allowPrivateCidrs: LOOPBACK,
        ...options,
      },
      deps,
    );
  }
  return createOpenAiCompatibleProvider(
    {
      baseUrl: `${fake.origin}/v1`,
      key: new ModelKey(KEY),
      model: 'llama3.1:8b',
      allowPrivateCidrs: LOOPBACK,
      ...options,
    },
    deps,
  );
}

const ok = (kind: Kind, text = ANSWER): Reply =>
  kind === 'anthropic' ? anthropicMessage(text) : openAiCompletion(text);

const error = (kind: Kind, status: number, type: string, headers?: Record<string, string>) =>
  kind === 'anthropic'
    ? anthropicError(status, type, 'fake', headers)
    : openAiError(status, type, 'fake', headers);

describe('the error codes', () => {
  it('are the five stable codes callers branch on', () => {
    expect([...MODEL_ERROR_CODES]).toEqual([
      'model.not_configured',
      'model.timeout',
      'model.overloaded',
      'model.refused',
      'model.bad_output',
    ]);
  });
});

describe('the Anthropic adapter', () => {
  it('sends one Messages request with the key only in x-api-key and no stream', async () => {
    const deps = testDeps();
    fake.reply(anthropicMessage(ANSWER));
    const result = await provider('anthropic', deps).complete(
      request({ cacheSystem: true }),
      signal(),
    );
    expect(result.ok).toBe(true);
    expect(fake.requests).toHaveLength(1);
    const [sent] = fake.requests;
    expect(sent?.method).toBe('POST');
    expect(sent?.path).toBe('/v1/messages');
    expect(sent?.headers['x-api-key']).toBe(KEY);
    expect(sent?.headers['anthropic-version']).toBe('2023-06-01');
    expect(sent?.headers['content-type']).toBe('application/json');
    expect(sent?.headers['accept-encoding']).toBe('identity');
    expect(sent?.headers['authorization']).toBeUndefined();
    expect(sent?.body).toEqual({
      model: 'claude-sonnet-5-5',
      max_tokens: 1500,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }],
    });
  });

  it('leaves the system prompt uncached unless asked, and omits it when there is none', async () => {
    const deps = testDeps();
    fake.reply(anthropicMessage(ANSWER));
    await provider('anthropic', deps).complete(request(), signal());
    const bare: ModelRequest = {
      tenant: TENANT,
      messages: [{ role: 'user', text: PROMPT }],
      maxOutputTokens: 1500,
    };
    await provider('anthropic', deps).complete(bare, signal());
    expect(fake.requests[0]?.body).toMatchObject({ system: [{ type: 'text', text: SYSTEM }] });
    expect(Reflect.get(fake.requests[0]?.body as object, 'system')).toEqual([
      { type: 'text', text: SYSTEM },
    ]);
    expect(Reflect.has(fake.requests[1]?.body as object, 'system')).toBe(false);
  });

  it('uses the model the request names, such as the check and premium models', async () => {
    const deps = testDeps();
    fake.reply(anthropicMessage(ANSWER, { model: 'claude-haiku-5-5' }));
    const result = await provider('anthropic', deps).complete(
      request({ model: 'claude-haiku-5-5' }),
      signal(),
    );
    await provider('anthropic', deps).complete(request({ model: 'claude-opus-5-5' }), signal());
    expect(fake.requests.map((r): unknown => Reflect.get(r.body as object, 'model'))).toEqual([
      'claude-haiku-5-5',
      'claude-opus-5-5',
    ]);
    expect(result.ok && result.value.model).toBe('claude-haiku-5-5');
  });

  it('keeps the turn order of a conversation', async () => {
    const deps = testDeps();
    fake.reply(anthropicMessage(ANSWER));
    await provider('anthropic', deps).complete(
      request({
        messages: [
          { role: 'user', text: 'one' },
          { role: 'assistant', text: 'two' },
          { role: 'user', text: 'three' },
        ],
      }),
      signal(),
    );
    expect(Reflect.get(fake.requests[0]?.body as object, 'messages')).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'one' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
      { role: 'user', content: [{ type: 'text', text: 'three' }] },
    ]);
  });

  it('reports usage in integer token units split the way credits are priced', async () => {
    const deps = testDeps();
    fake.reply(anthropicMessage(ANSWER));
    const result = await provider('anthropic', deps).complete(request(), signal());
    expect(result).toEqual({
      ok: true,
      value: {
        text: ANSWER,
        model: 'claude-sonnet-5-5',
        stopReason: 'end',
        usage: { input: 1200, cacheWrite5m: 200, cacheWrite1h: 100, cacheRead: 900, output: 240 },
        attempts: 1,
      },
    });
    if (result.ok && result.value.usage !== undefined) {
      for (const count of Object.values(result.value.usage)) {
        expect(Number.isSafeInteger(count)).toBe(true);
      }
    }
  });

  it('counts every cache write as five minute when the breakdown is missing', async () => {
    const deps = testDeps();
    fake.reply(
      anthropicMessage(ANSWER, {
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 70 },
      }),
    );
    const result = await provider('anthropic', deps).complete(request(), signal());
    expect(result.ok && result.value.usage).toEqual({
      input: 10,
      cacheWrite5m: 70,
      cacheWrite1h: 0,
      cacheRead: 0,
      output: 5,
    });
  });

  it('joins text blocks and skips thinking blocks', async () => {
    const deps = testDeps();
    fake.reply(
      anthropicMessage('second', {
        extraBlocks: [
          { type: 'thinking', thinking: 'hidden', signature: 'sig' },
          { type: 'text', text: 'first ' },
        ],
      }),
    );
    const result = await provider('anthropic', deps).complete(request(), signal());
    expect(result.ok && result.value.text).toBe('first second');
  });

  it.each([
    ['max_tokens', 'max_tokens'],
    ['model_context_window_exceeded', 'max_tokens'],
    ['stop_sequence', 'end'],
  ])('maps the stop reason %s to %s', async (stop, expected) => {
    const deps = testDeps();
    fake.reply(anthropicMessage(ANSWER, { stop }));
    const result = await provider('anthropic', deps).complete(request(), signal());
    expect(result.ok && result.value.stopReason).toBe(expected);
  });

  it('returns model.refused for a refusal stop', async () => {
    const deps = testDeps();
    fake.reply(anthropicMessage('', { stop: 'refusal' }));
    const result = await provider('anthropic', deps).complete(request(), signal());
    expect(result).toEqual({
      ok: false,
      error: { code: 'model.refused', cause: 'refusal', attempts: 1 },
    });
  });

  it.each(['tool_use', 'pause_turn', 'something_new'])(
    'returns model.bad_output for the stop reason %s, which no caller asked for',
    async (stop) => {
      const deps = testDeps();
      fake.reply(anthropicMessage(ANSWER, { stop }));
      const result = await provider('anthropic', deps).complete(request(), signal());
      expect(result).toEqual({
        ok: false,
        error: { code: 'model.bad_output', cause: 'unexpected_stop', attempts: 1 },
      });
    },
  );

  it('returns model.overloaded for 529, the Anthropic overload status', async () => {
    const deps = testDeps();
    fake.reply(error('anthropic', 529, 'overloaded_error'));
    const result = await provider('anthropic', deps).complete(request(), signal());
    expect(result).toEqual({
      ok: false,
      error: { code: 'model.overloaded', cause: 'overloaded', status: 529, attempts: 3 },
    });
    expect(fake.requests).toHaveLength(3);
  });

  it('refuses to build without a key, so a hosted call can never go out unsigned', () => {
    expect(() =>
      createAnthropicProvider({ baseUrl: fake.origin, model: 'claude-sonnet-5-5' }, testDeps()),
    ).toThrow(TypeError);
  });
});

describe('the OpenAI compatible adapter', () => {
  it('sends one chat completions request with a bearer key and stream off', async () => {
    const deps = testDeps();
    fake.reply(openAiCompletion(ANSWER));
    await provider('openai_compatible', deps).complete(request(), signal());
    const [sent] = fake.requests;
    expect(sent?.method).toBe('POST');
    expect(sent?.path).toBe('/v1/chat/completions');
    expect(sent?.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(sent?.headers['x-api-key']).toBeUndefined();
    expect(sent?.body).toEqual({
      model: 'llama3.1:8b',
      max_tokens: 1500,
      stream: false,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: PROMPT },
      ],
    });
  });

  it('sends no authorization header at all when there is no key', async () => {
    const deps = testDeps();
    fake.reply(openAiCompletion(ANSWER));
    const local = createOpenAiCompatibleProvider(
      { baseUrl: `${fake.origin}/v1/`, model: 'llama3.1:8b', allowPrivateCidrs: LOOPBACK },
      deps,
    );
    const result = await local.complete(request(), signal());
    expect(result.ok).toBe(true);
    expect(fake.requests[0]?.path).toBe('/v1/chat/completions');
    expect(fake.requests[0]?.headers['authorization']).toBeUndefined();
  });

  it('reports cached prompt tokens as cache reads and the rest as input', async () => {
    const deps = testDeps();
    fake.reply(openAiCompletion(ANSWER));
    const result = await provider('openai_compatible', deps).complete(request(), signal());
    expect(result).toEqual({
      ok: true,
      value: {
        text: ANSWER,
        model: 'llama3.1:8b',
        stopReason: 'end',
        usage: { input: 1000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 500, output: 320 },
        attempts: 1,
      },
    });
  });

  it('treats a missing cache breakdown as no cache', async () => {
    const deps = testDeps();
    fake.reply(openAiCompletion(ANSWER, { usage: { prompt_tokens: 40, completion_tokens: 7 } }));
    const result = await provider('openai_compatible', deps).complete(request(), signal());
    expect(result.ok && result.value.usage).toEqual({
      input: 40,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
      output: 7,
    });
  });

  it('drops usage that claims more cached tokens than prompt tokens', async () => {
    const deps = testDeps();
    fake.reply(
      openAiCompletion(ANSWER, {
        usage: {
          prompt_tokens: 10,
          completion_tokens: 7,
          prompt_tokens_details: { cached_tokens: 11 },
        },
      }),
    );
    const result = await provider('openai_compatible', deps).complete(request(), signal());
    expect(result.ok && result.value.usage).toBeUndefined();
  });

  it.each([
    ['length', 'max_tokens'],
    [null, 'end'],
  ])('maps the finish reason %s to %s', async (finish, expected) => {
    const deps = testDeps();
    fake.reply(openAiCompletion(ANSWER, { finish }));
    const result = await provider('openai_compatible', deps).complete(request(), signal());
    expect(result.ok && result.value.stopReason).toBe(expected);
  });

  it('returns model.refused for a content filter stop and for a refusal message', async () => {
    const deps = testDeps();
    fake.reply(openAiCompletion(null, { finish: 'content_filter' }));
    const filtered = await provider('openai_compatible', deps).complete(request(), signal());
    fake.reply(openAiCompletion(null, { refusal: 'I cannot help with that.' }));
    const refused = await provider('openai_compatible', deps).complete(request(), signal());
    expect(filtered).toEqual({
      ok: false,
      error: { code: 'model.refused', cause: 'content_filter', attempts: 1 },
    });
    expect(refused).toEqual({
      ok: false,
      error: { code: 'model.refused', cause: 'refusal', attempts: 1 },
    });
  });

  it.each(['tool_calls', 'function_call'])(
    'returns model.bad_output for the finish reason %s',
    async (finish) => {
      const deps = testDeps();
      fake.reply(openAiCompletion(ANSWER, { finish }));
      const result = await provider('openai_compatible', deps).complete(request(), signal());
      expect(result.ok ? undefined : result.error.cause).toBe('unexpected_stop');
    },
  );

  it('returns model.bad_output when there is no choice', async () => {
    const deps = testDeps();
    fake.reply({ kind: 'json', status: 200, body: { id: 'x', model: 'm', choices: [] } });
    const result = await provider('openai_compatible', deps).complete(request(), signal());
    expect(result.ok ? undefined : result.error).toEqual({
      code: 'model.bad_output',
      cause: 'malformed',
      attempts: 1,
    });
  });
});

describe.each<Kind>(['anthropic', 'openai_compatible'])('%s errors', (kind) => {
  it.each([
    [429, 'rate_limit_error', 'model.overloaded', 'rate_limited', 3],
    [500, 'api_error', 'model.overloaded', 'server_error', 3],
    [502, 'api_error', 'model.overloaded', 'server_error', 3],
    [503, 'api_error', 'model.overloaded', 'overloaded', 3],
    [504, 'api_error', 'model.overloaded', 'server_error', 3],
    [401, 'authentication_error', 'model.refused', 'auth', 1],
    [403, 'permission_error', 'model.refused', 'auth', 1],
    [404, 'not_found_error', 'model.refused', 'not_found', 1],
    [400, 'invalid_request_error', 'model.refused', 'bad_request', 1],
    [413, 'request_too_large', 'model.refused', 'bad_request', 1],
    [422, 'invalid_request_error', 'model.refused', 'bad_request', 1],
    [408, 'timeout_error', 'model.timeout', 'timeout', 1],
    [418, 'teapot', 'model.bad_output', 'malformed', 1],
  ] as const)(
    'maps HTTP %i (%s) to %s with cause %s after %i attempts',
    async (status, type, code, cause, attempts) => {
      const deps = testDeps();
      fake.reply(error(kind, status, type));
      const result = await provider(kind, deps).complete(request(), signal());
      expect(result).toEqual({ ok: false, error: { code, cause, status, attempts } });
      expect(fake.requests).toHaveLength(attempts);
    },
  );

  it('returns model.bad_output for a body that is not JSON', async () => {
    const deps = testDeps();
    fake.reply(raw(200, '<html>gateway</html>', { 'content-type': 'text/html' }));
    const result = await provider(kind, deps).complete(request(), signal());
    expect(result).toEqual({
      ok: false,
      error: { code: 'model.bad_output', cause: 'malformed', attempts: 1 },
    });
  });

  it('returns model.bad_output for bytes that are not UTF-8', async () => {
    const deps = testDeps();
    fake.reply(raw(200, new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])));
    const result = await provider(kind, deps).complete(request(), signal());
    expect(result.ok ? undefined : result.error.cause).toBe('malformed');
  });

  it('returns model.bad_output for a compressed body it never asked for', async () => {
    const deps = testDeps();
    fake.reply(raw(200, new Uint8Array([0x1f, 0x8b, 0x08]), { 'content-encoding': 'gzip' }));
    const result = await provider(kind, deps).complete(request(), signal());
    expect(result.ok ? undefined : result.error.cause).toBe('malformed');
  });

  it('returns model.bad_output for JSON of the wrong shape', async () => {
    const deps = testDeps();
    fake.reply({ kind: 'json', status: 200, body: { hello: 'world' } });
    const result = await provider(kind, deps).complete(request(), signal());
    expect(result.ok ? undefined : result.error.cause).toBe('malformed');
  });

  it('returns model.bad_output for an empty answer that claims to be finished', async () => {
    const deps = testDeps();
    fake.reply(ok(kind, ''));
    const result = await provider(kind, deps).complete(request(), signal());
    expect(result).toEqual({
      ok: false,
      error: { code: 'model.bad_output', cause: 'empty', attempts: 1 },
    });
  });

  it('returns model.bad_output with cause too_large for an answer past the size cap', async () => {
    const deps = testDeps();
    fake.reply(raw(200, new Uint8Array(5 * 1024 * 1024).fill(0x20)));
    const result = await provider(kind, deps).complete(request(), signal());
    expect(result).toEqual({
      ok: false,
      error: { code: 'model.bad_output', cause: 'too_large', attempts: 1 },
    });
  });

  it('returns model.not_configured for a redirect, which a provider never sends', async () => {
    const deps = testDeps();
    fake.reply(raw(307, '', { location: 'http://127.0.0.1:1/' }));
    const result = await provider(kind, deps).complete(request(), signal());
    expect(result).toEqual({
      ok: false,
      error: { code: 'model.not_configured', cause: 'endpoint_denied', attempts: 1 },
    });
  });

  it('returns model.timeout when the answer does not arrive in time, and does not retry', async () => {
    const deps = testDeps();
    fake.reply(hang);
    const started = Date.now();
    const result = await provider(kind, deps, { timeoutMs: 300 }).complete(request(), signal());
    expect(result).toEqual({
      ok: false,
      error: { code: 'model.timeout', cause: 'timeout', attempts: 1 },
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fake.requests).toHaveLength(1);
  });

  it('retries a dropped connection and returns the answer that follows', async () => {
    const deps = testDeps();
    fake.reply(reset, ok(kind));
    const result = await provider(kind, deps).complete(request(), signal());
    expect(result.ok && result.value.attempts).toBe(2);
    expect(fake.requests).toHaveLength(2);
  });

  it('gives up on dropped connections with model.overloaded after the attempt budget', async () => {
    const deps = testDeps();
    fake.reply(reset);
    const result = await provider(kind, deps).complete(request(), signal());
    expect(result).toEqual({
      ok: false,
      error: { code: 'model.overloaded', cause: 'unreachable', attempts: 3 },
    });
  });

  it('retries a rate limit with jittered backoff and returns the answer that follows', async () => {
    const deps = testDeps({ random: () => 0.25 });
    fake.reply(
      error(kind, 429, 'rate_limit_error'),
      error(kind, 429, 'rate_limit_error'),
      ok(kind),
    );
    const result = await provider(kind, deps).complete(request(), signal());
    expect(result.ok && result.value.attempts).toBe(3);
    // Full jitter: a quarter of 500 ms, then a quarter of 1000 ms.
    expect(deps.sleeps).toEqual([125, 250]);
  });

  it('waits as long as Retry-After asks when that is within the cap', async () => {
    const deps = testDeps();
    fake.reply(error(kind, 429, 'rate_limit_error', { 'retry-after': '2' }), ok(kind));
    const result = await provider(kind, deps).complete(request(), signal());
    expect(result.ok).toBe(true);
    expect(deps.sleeps).toEqual([2_000]);
  });

  it('stops at once when Retry-After asks for longer than the cap', async () => {
    const deps = testDeps();
    fake.reply(error(kind, 429, 'rate_limit_error', { 'retry-after': '60' }), ok(kind));
    const result = await provider(kind, deps).complete(request(), signal());
    expect(result).toEqual({
      ok: false,
      error: { code: 'model.overloaded', cause: 'rate_limited', status: 429, attempts: 1 },
    });
    expect(deps.sleeps).toEqual([]);
  });

  it('ignores a Retry-After it cannot read and uses its own backoff', async () => {
    const deps = testDeps({ random: () => 1 });
    fake.reply(error(kind, 503, 'api_error', { 'retry-after': 'soon' }), ok(kind));
    await provider(kind, deps).complete(request(), signal());
    expect(deps.sleeps).toEqual([500]);
  });

  it('makes one attempt when the budget is one', async () => {
    const deps = testDeps();
    fake.reply(error(kind, 529, 'overloaded_error'), ok(kind));
    const result = await provider(kind, deps, { maxAttempts: 1 }).complete(request(), signal());
    expect(result.ok ? undefined : result.error.attempts).toBe(1);
    expect(fake.requests).toHaveLength(1);
  });

  it('refuses an attempt budget outside 1 to 5 and a timeout that is not a positive integer', () => {
    for (const options of [
      { maxAttempts: 0 },
      { maxAttempts: 6 },
      { timeoutMs: 0 },
      { timeoutMs: 1.5 },
    ]) {
      expect(() => provider(kind, testDeps(), options), JSON.stringify(options)).toThrow(TypeError);
    }
  });
});

describe('every call goes through the egress guard', () => {
  it.each<Kind>(['anthropic', 'openai_compatible'])(
    '%s: a loopback endpoint with no private allowance is refused before any request',
    async (kind) => {
      const deps = testDeps();
      fake.reply(ok(kind));
      const make =
        kind === 'anthropic'
          ? createAnthropicProvider(
              { baseUrl: fake.origin, key: new ModelKey(KEY), model: 'claude-sonnet-5-5' },
              deps,
            )
          : createOpenAiCompatibleProvider({ baseUrl: `${fake.origin}/v1`, model: 'm' }, deps);
      const result = await make.complete(request(), signal());
      expect(result).toEqual({
        ok: false,
        error: { code: 'model.not_configured', cause: 'endpoint_denied', attempts: 1 },
      });
      expect(fake.requests).toHaveLength(0);
    },
  );

  it('refuses a cloud metadata address even with loopback allowed', async () => {
    const deps = testDeps();
    const result = await createOpenAiCompatibleProvider(
      { baseUrl: 'http://169.254.169.254/v1', model: 'm', allowPrivateCidrs: LOOPBACK },
      deps,
    ).complete(request(), signal());
    expect(result.ok ? undefined : result.error).toEqual({
      code: 'model.not_configured',
      cause: 'endpoint_denied',
      attempts: 1,
    });
  });

  it('refuses plain http to a public host when no private range is allowed', async () => {
    const deps = testDeps();
    const result = await createOpenAiCompatibleProvider(
      { baseUrl: 'http://93.184.215.14/v1', model: 'm' },
      deps,
    ).complete(request(), signal());
    expect(result.ok ? undefined : result.error.code).toBe('model.not_configured');
  });

  it('refuses a base URL that carries credentials, a query or a fragment', () => {
    for (const baseUrl of [
      'https://user:pass@api.example.com/v1',
      'https://api.example.com/v1?x=1',
      'https://api.example.com/v1#x',
      'ftp://api.example.com/v1',
      'not a url',
    ]) {
      expect(
        () => createOpenAiCompatibleProvider({ baseUrl, model: 'm' }, testDeps()),
        baseUrl,
      ).toThrow(TypeError);
    }
  });
});

describe('with nothing configured', () => {
  it('returns model.not_configured and makes no request', async () => {
    const deps = testDeps();
    const none = createModelProvider({ kind: 'none' }, deps);
    const result = await none.complete(request(), signal());
    expect(none.kind).toBe('none');
    expect(result).toEqual({
      ok: false,
      error: { code: 'model.not_configured', cause: 'unset', attempts: 0 },
    });
    expect(fake.requests).toHaveLength(0);
  });

  it('builds the configured adapter when there is one', async () => {
    const deps = testDeps();
    fake.reply(openAiCompletion(ANSWER));
    const built = createModelProvider(
      {
        kind: 'openai_compatible',
        baseUrl: `${fake.origin}/v1`,
        key: undefined,
        model: 'llama3.1:8b',
        allowPrivateCidrs: LOOPBACK,
      },
      deps,
    );
    expect(built.kind).toBe('openai_compatible');
    expect((await built.complete(request(), signal())).ok).toBe(true);

    fake.reply(anthropicMessage(ANSWER));
    const anthropic = createModelProvider(
      {
        kind: 'anthropic',
        baseUrl: fake.origin,
        key: new ModelKey(KEY),
        model: 'claude-sonnet-5-5',
        allowPrivateCidrs: LOOPBACK,
      },
      deps,
    );
    expect(anthropic.kind).toBe('anthropic');
    expect((await anthropic.complete(request(), signal())).ok).toBe(true);
  });
});

describe('the ai.model_calls kill switch', () => {
  it.each<Kind>(['anthropic', 'openai_compatible'])(
    '%s: off returns model.not_configured with cause paused and sends nothing',
    async (kind) => {
      const deps = testDeps();
      deps.gate.on = false;
      fake.reply(ok(kind));
      const result = await provider(kind, deps).complete(request(), signal());
      expect(result).toEqual({
        ok: false,
        error: { code: 'model.not_configured', cause: 'paused', attempts: 0 },
      });
      expect(fake.requests).toHaveLength(0);
      expect(deps.gate.asked).toEqual([
        { name: 'ai.model_calls', organizationId: TENANT.organizationId },
      ]);
    },
  );

  it.each<Kind>(['anthropic', 'openai_compatible'])(
    '%s: on lets the call through',
    async (kind) => {
      const deps = testDeps();
      fake.reply(ok(kind));
      const result = await provider(kind, deps).complete(request(), signal());
      expect(result.ok).toBe(true);
      expect(fake.requests).toHaveLength(1);
    },
  );

  it('fails closed when the flag cannot be read', async () => {
    const deps = testDeps({
      gate: { isOn: () => Promise.reject(new Error('flagd down')) },
    });
    fake.reply(ok('anthropic'));
    const result = await provider('anthropic', deps).complete(request(), signal());
    expect(result.ok ? undefined : result.error.cause).toBe('paused');
    expect(fake.requests).toHaveLength(0);
  });
});

describe('abort signals', () => {
  it.each<Kind>(['anthropic', 'openai_compatible'])(
    '%s: an aborted signal sends nothing',
    async (kind) => {
      const deps = testDeps();
      const controller = new AbortController();
      controller.abort();
      fake.reply(ok(kind));
      const result = await provider(kind, deps).complete(request(), controller.signal);
      expect(result).toEqual({
        ok: false,
        error: { code: 'model.timeout', cause: 'aborted', attempts: 0 },
      });
      expect(fake.requests).toHaveLength(0);
    },
  );

  it.each<Kind>(['anthropic', 'openai_compatible'])(
    '%s: aborting mid request closes the connection and returns at once',
    async (kind) => {
      const deps = testDeps();
      const controller = new AbortController();
      fake.reply(hang);
      const pending = provider(kind, deps).complete(request(), controller.signal);
      while (fake.requests.length === 0) await new Promise((r) => setTimeout(r, 5));
      const started = Date.now();
      controller.abort();
      const result = await pending;
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(result).toEqual({
        ok: false,
        error: { code: 'model.timeout', cause: 'aborted', attempts: 1 },
      });
      expect(await fake.closedHeld()).toBeGreaterThan(0);
    },
  );

  it('an abort during backoff stops the retries', async () => {
    const controller = new AbortController();
    const deps = testDeps({
      sleep: (_ms, sleepSignal) => {
        controller.abort();
        return Promise.reject(sleepSignal.reason as Error);
      },
    });
    fake.reply(error('anthropic', 529, 'overloaded_error'), ok('anthropic'));
    const result = await provider('anthropic', deps).complete(request(), controller.signal);
    expect(result).toEqual({
      ok: false,
      error: { code: 'model.timeout', cause: 'aborted', attempts: 1 },
    });
    expect(fake.requests).toHaveLength(1);
  });

  it('waits on the real clock by default and wakes early on abort', async () => {
    const deps = testDeps({ random: () => 1 }, { realSleep: true });
    const controller = new AbortController();
    fake.reply(error('anthropic', 529, 'overloaded_error'), ok('anthropic'));
    const pending = provider('anthropic', deps).complete(request(), controller.signal);
    while (fake.requests.length === 0) await new Promise((r) => setTimeout(r, 5));
    setTimeout(() => {
      controller.abort();
    }, 20);
    const result = await pending;
    expect(result.ok ? undefined : result.error.cause).toBe('aborted');
    expect(fake.requests).toHaveLength(1);
  });

  it('retries on the real clock when nothing aborts', async () => {
    const deps = testDeps({}, { realSleep: true, realRandom: true });
    fake.reply(error('anthropic', 529, 'overloaded_error'), ok('anthropic'));
    const result = await provider('anthropic', deps).complete(request(), signal());
    expect(result.ok && result.value.attempts).toBe(2);
  });
});

describe('request checks', () => {
  it('throws on a request no caller should build: no messages, a bad output cap or a bad model', async () => {
    const deps = testDeps();
    const p = provider('anthropic', deps);
    const bad: unknown[] = [
      { ...request(), messages: [] },
      { ...request(), maxOutputTokens: 0 },
      { ...request(), maxOutputTokens: 1.5 },
      { ...request(), maxOutputTokens: 200_001 },
      { ...request(), model: '' },
      { ...request(), model: 'has space' },
      { ...request(), messages: [{ role: 'system', text: 'x' }] },
    ];
    for (const value of bad) {
      await expect(
        p.complete(value as ModelRequest, signal()),
        JSON.stringify(value),
      ).rejects.toThrow(TypeError);
    }
    expect(fake.requests).toHaveLength(0);
  });
});
