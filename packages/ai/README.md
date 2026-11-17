# `@drefyn/ai`

The one way to call a language model. Update drafts, the reader assistant, translations,
incident drafts and docs generation all take a `ModelProvider` from here, and the
`drefyn/no-direct-model-call` lint rule fails a provider URL, path, header or vendor SDK
anywhere else.

Two adapters speak the wire formats directly, with no vendor SDK, and every request goes
out through `@drefyn/egress`:

- Anthropic Messages (`/v1/messages`), the hosted default.
- Any OpenAI compatible chat completions endpoint (`/chat/completions`): a gateway, or a
  model on the operator's own machine with no key and nothing paid.

## Public API

```ts
import { createModelProvider, loadModelConfig } from '@drefyn/ai';

const provider = createModelProvider(await loadModelConfig(process.env), {
  gate: flagClient, // isOn('ai.model_calls', { organizationId, projectId })
  logger, // { info(event, fields), warn(event, fields) }
  metrics, // optional { increment(name, labels), observe(name, value, labels) }
});

const result = await provider.complete(
  {
    tenant, // { organizationId, projectId }, for logs and metrics only
    model: 'claude-haiku-5-5', // optional; defaults to the configured model
    system: 'Answer from the sources only.',
    cacheSystem: true,
    messages: [{ role: 'user', text: question }],
    maxOutputTokens: 1500,
  },
  AbortSignal.timeout(20_000),
);
if (result.ok) {
  result.value.text;
  result.value.stopReason; // 'end' | 'max_tokens'
  result.value.usage; // { input, cacheWrite5m, cacheWrite1h, cacheRead, output } or undefined
  result.value.model; // the model asked for, which is what the call is priced on
} else {
  result.error; // { code: 'model.overloaded', cause: 'rate_limited', status: 429, attempts: 3 }
}
```

`createAnthropicProvider` and `createOpenAiCompatibleProvider` build one adapter from
options: `baseUrl`, `key` (a `ModelKey`), `model`, `allowPrivateCidrs`, `timeoutMs` (per
attempt, default 120 s) and `maxAttempts` (1 to 5, default 3).

## Errors

Every outcome the provider or the network can cause comes back as a `Result`. Only a
request no caller should build rejects: no messages, a role other than user or assistant,
an output cap outside 1 to 200,000, or a bad model name.

| Code                   | Cause             | When                                                           |
| ---------------------- | ----------------- | -------------------------------------------------------------- |
| `model.not_configured` | `unset`           | No `DREFYN_MODEL_PROVIDER`                                     |
|                        | `paused`          | The `ai.model_calls` kill switch is off or cannot be read      |
|                        | `endpoint_denied` | The egress guard refused the endpoint, or it redirected        |
| `model.timeout`        | `timeout`         | No full answer within `timeoutMs`, or HTTP 408                 |
|                        | `aborted`         | The caller's signal fired                                      |
| `model.overloaded`     | `rate_limited`    | HTTP 429                                                       |
|                        | `overloaded`      | HTTP 503 or 529                                                |
|                        | `server_error`    | Any other 5xx                                                  |
|                        | `unreachable`     | DNS failure, connect timeout, refused or dropped connection    |
| `model.refused`        | `auth`            | HTTP 401 or 403, such as a revoked key                         |
|                        | `not_found`       | HTTP 404, usually an unknown model                             |
|                        | `bad_request`     | HTTP 400, 413 or 422                                           |
|                        | `refusal`         | The model declined                                             |
|                        | `content_filter`  | The endpoint's filter stopped the answer                       |
| `model.bad_output`     | `malformed`       | Not UTF-8 JSON of the expected shape, compressed, or other 4xx |
|                        | `empty`           | A finished answer with no text                                 |
|                        | `unexpected_stop` | A stop reason no caller asked for, such as a tool call         |
|                        | `too_large`       | The answer passed the 4 MiB cap                                |

`model.overloaded` causes are retried, up to `maxAttempts` requests in all, with full
jitter backoff from 500 ms doubling to an 8 s cap. A `Retry-After` in seconds is honoured
up to 8 s; a longer one ends the call at once. Nothing else is retried: a timeout may
have run the prompt already, and the rest will not change on a second try.

## Usage and credits

Usage is reported in integer token units split the way the rate table prices them.
Anthropic's cache writes are split into five minute and one hour writes; when the split
is missing, every write counts as five minute, the cheaper rate. OpenAI compatible cached
prompt tokens count as cache reads and the rest of the prompt as input. A count that is
not a non negative safe integer, or more cached tokens than prompt tokens, drops the
whole usage to `undefined`, so settlement keeps the hold instead of charging a number a
provider made up.

## Settings

| Key                                | Default                                   | Meaning                                                                                       |
| ---------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| `DREFYN_MODEL_PROVIDER`            | unset                                     | `anthropic` or `openai_compatible`. Unset means no model: AI features stay off and say so     |
| `DREFYN_MODEL_BASE_URL`            | `https://api.anthropic.com` for Anthropic | The API root. Required for `openai_compatible`, for example `http://ollama:11434/v1`          |
| `DREFYN_MODEL_KEY_FILE`            | unset                                     | A file holding the key. Required for Anthropic, optional for `openai_compatible`              |
| `DREFYN_MODEL_NAME`                | `claude-sonnet-5-5` for Anthropic         | The default model. Required for `openai_compatible`                                           |
| `DREFYN_MODEL_ALLOW_PRIVATE_CIDRS` | unset                                     | Self host only: comma list of private ranges the endpoint sits on; also allows http, any port |

A bad setting fails startup with `ModelConfigError`, which names the setting and never
its value. Plain http is refused unless a private range is listed, since it would carry
the key in the clear.

## What never leaves

The key is a `ModelKey`: printing, logging, serialising or inspecting it shows
`[redacted]`, and only the adapter's auth header reads it. `hint` gives the last four
characters for a settings page. Logs and metrics carry the organization, project,
provider, model, attempt counts, codes, durations and token counts, never prompts,
system text, answers, keys, hints or the endpoint. Provider error messages are dropped
unread, since a provider may echo what it was sent.

Logged events: `ai.model_call` (info, with token counts), `ai.usage_missing` (warn),
`ai.model_call_retry` (info) and `ai.model_call_failed` (warn). Metrics:
`ai_model_calls_total` with an `outcome` label and `ai_model_call_duration_ms`.

## Tests

- `test/adapters.test.ts`: both adapters against a fake provider on loopback, through the
  real egress guard: request and response mapping, every error code, retries and
  backoff, the kill switch both ways, abort, and endpoints the guard refuses.
- `test/redaction.test.ts`: a provider that echoes the key, prompt and system text into
  errors; none of it reaches a log, an error or a metric. Tenant ids on every line.
- `test/hostile.property.test.ts`: fast-check over arbitrary bytes, JSON and token counts.
- `test/local-endpoint.test.ts`: the self host path from settings alone, with no key.
- `test/support/fake-provider.ts` refuses streaming requests and never forwards
  anything, so no test can reach a real provider.
