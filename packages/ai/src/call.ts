import { setTimeout as delay } from 'node:timers/promises';
import type { TokenUsage } from '@drefyn/credits';
import { guardedFetch, policyFor, type EgressError, type EgressPolicy } from '@drefyn/egress';
import type { ModelKey } from './key.ts';
import type {
  LogFields,
  MetricLabels,
  ModelDeps,
  ModelError,
  ModelErrorCause,
  ModelErrorCode,
  ModelProvider,
  ModelProviderKind,
  ModelRequest,
  ModelResponse,
  Result,
  StopReason,
} from './types.ts';

export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_OUTPUT_TOKENS = 200_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
// Also the longest Retry-After honoured: a provider asking for more is better answered by
// the caller's own fallback than by holding a request open.
const BACKOFF_CAP_MS = 8_000;

export interface Failure {
  readonly code: ModelErrorCode;
  readonly cause: ModelErrorCause;
  readonly status?: number;
}

export interface Answer {
  readonly text: string;
  readonly stopReason: StopReason;
  readonly usage: TokenUsage | undefined;
}

export type Read = Result<Answer, Failure>;

/** What differs between providers: where the request goes, its shape, and the answer's. */
export interface WireFormat {
  readonly kind: ModelProviderKind;
  readonly path: string;
  headers(key: ModelKey | undefined): Readonly<Record<string, string>>;
  body(request: ModelRequest, model: string): unknown;
  read(body: Uint8Array): Read;
}

export interface AdapterOptions {
  /** The API root, without the provider's own path: https://api.anthropic.com, or http://host:11434/v1. */
  readonly baseUrl: string;
  readonly key?: ModelKey;
  /** Used when a request names no model. */
  readonly model: string;
  /** Self host only: private ranges the endpoint may sit on. Also allows plain http on any port. */
  readonly allowPrivateCidrs?: readonly string[];
  /** Per attempt, connect to last byte. Defaults to the egress model policy, 120 s. */
  readonly timeoutMs?: number;
  /** Requests per call, 1 to 5. Defaults to 3. */
  readonly maxAttempts?: number;
}

const fail = (code: ModelErrorCode, cause: ModelErrorCause, status?: number): Failure =>
  status === undefined ? { code, cause } : { code, cause, status };

export const badOutput = (cause: ModelErrorCause): Read => ({
  ok: false,
  error: fail('model.bad_output', cause),
});

export const refused = (cause: ModelErrorCause): Read => ({
  ok: false,
  error: fail('model.refused', cause),
});

// The text of a body, or undefined when it is not UTF-8 JSON. Deep nesting throws a
// RangeError in JSON.parse, which lands here too.
export function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
  } catch {
    return undefined;
  }
}

const RETRYABLE: ReadonlySet<ModelErrorCause> = new Set([
  'unreachable',
  'rate_limited',
  'overloaded',
  'server_error',
]);

// Both providers use HTTP the same way, and 529 is Anthropic's overload status.
function statusFailure(status: number): Failure {
  if (status === 429) return fail('model.overloaded', 'rate_limited', status);
  if (status === 503 || status === 529) return fail('model.overloaded', 'overloaded', status);
  if (status >= 500) return fail('model.overloaded', 'server_error', status);
  if (status === 401 || status === 403) return fail('model.refused', 'auth', status);
  if (status === 404) return fail('model.refused', 'not_found', status);
  if (status === 400 || status === 413 || status === 422) {
    return fail('model.refused', 'bad_request', status);
  }
  if (status === 408) return fail('model.timeout', 'timeout', status);
  return fail('model.bad_output', 'malformed', status);
}

function egressFailure(error: EgressError): Failure {
  switch (error.code) {
    case 'egress.timeout':
      return fail('model.timeout', 'timeout');
    case 'egress.aborted':
      return fail('model.timeout', 'aborted');
    // Nothing reached the provider, so trying again cannot run the prompt twice.
    case 'egress.connect_timeout':
    case 'egress.dns_failed':
    case 'egress.network_failed':
      return fail('model.overloaded', 'unreachable');
    case 'egress.too_large':
      return fail('model.bad_output', 'too_large');
    default:
      return fail('model.not_configured', 'endpoint_denied');
  }
}

function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get('retry-after');
  if (value === null || !/^\d{1,6}$/.test(value.trim())) return undefined;
  return Number(value.trim()) * 1000;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  delay(ms, undefined, { signal });

export function checkBaseUrl(baseUrl: string): string {
  const url = URL.parse(baseUrl);
  // The message leaves the value out: a mistyped URL can carry a key in its userinfo.
  if (
    url === null ||
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    baseUrl.includes('?') ||
    baseUrl.includes('#')
  ) {
    throw new TypeError('ai: baseUrl must be an http or https URL with no credentials or query');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function checkRequest(request: ModelRequest, model: string): void {
  const messages: readonly unknown[] = Array.isArray(request.messages) ? request.messages : [];
  const wellFormed = messages.every(
    (m) =>
      typeof m === 'object' &&
      m !== null &&
      (Reflect.get(m, 'role') === 'user' || Reflect.get(m, 'role') === 'assistant') &&
      typeof Reflect.get(m, 'text') === 'string',
  );
  if (messages.length === 0 || !wellFormed) throw new TypeError('ai: request messages invalid');
  const cap: unknown = request.maxOutputTokens;
  if (typeof cap !== 'number' || !Number.isSafeInteger(cap) || cap < 1 || cap > MAX_OUTPUT_TOKENS) {
    throw new TypeError('ai: request maxOutputTokens invalid');
  }
  if (!MODEL_NAME.test(model)) throw new TypeError('ai: request model invalid');
}

function positiveInteger(value: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new TypeError(`ai: ${name} invalid`);
  }
  return value;
}

// A broken log or metrics sink must not fail the call it was describing.
function quietly(run: () => void): void {
  try {
    run();
  } catch {
    // Nothing safe to report it to.
  }
}

export function createAdapter(
  format: WireFormat,
  options: AdapterOptions,
  deps: ModelDeps,
): ModelProvider {
  const root = checkBaseUrl(options.baseUrl);
  if (!MODEL_NAME.test(options.model)) throw new TypeError('ai: model invalid');
  const attemptsAllowed = positiveInteger(
    options.maxAttempts ?? DEFAULT_ATTEMPTS,
    5,
    'maxAttempts',
  );
  const cidrs = options.allowPrivateCidrs ?? [];
  const base = policyFor('model', { allowPrivateCidrs: cidrs, modelLocal: cidrs.length > 0 });
  const policy: EgressPolicy =
    options.timeoutMs === undefined
      ? base
      : {
          ...base,
          totalTimeoutMs: positiveInteger(options.timeoutMs, MAX_TIMEOUT_MS, 'timeoutMs'),
        };
  const url = `${root}${format.path}`;
  const headers = format.headers(options.key);
  const random = deps.random ?? Math.random;
  const sleep = deps.sleep ?? defaultSleep;

  async function complete(
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<Result<ModelResponse, ModelError>> {
    const model = request.model ?? options.model;
    checkRequest(request, model);
    const { organizationId, projectId } = request.tenant;
    const context: LogFields = { organizationId, projectId, provider: format.kind, model };
    const labels: MetricLabels = { organizationId, projectId, provider: format.kind, model };
    const started = performance.now();

    const finish = (failure: Failure, attempts: number): Result<ModelResponse, ModelError> => {
      const error: ModelError = { ...failure, attempts };
      quietly(() => {
        deps.logger.warn('ai.model_call_failed', {
          ...context,
          code: error.code,
          cause: error.cause,
          attempts,
          ...(error.status === undefined ? {} : { status: error.status }),
        });
      });
      quietly(() =>
        deps.metrics?.increment('ai_model_calls_total', { ...labels, outcome: error.code }),
      );
      return { ok: false, error };
    };

    if (signal.aborted) return finish(fail('model.timeout', 'aborted'), 0);
    let open: boolean;
    try {
      open = await deps.gate.isOn('ai.model_calls', { organizationId, projectId });
    } catch {
      // Unknown means stopped: the switch exists to stop spend fast.
      open = false;
    }
    if (!open) return finish(fail('model.not_configured', 'paused'), 0);

    const payload = JSON.stringify(format.body(request, model));
    for (let attempt = 1; ; attempt += 1) {
      const sent = await guardedFetch(
        url,
        { method: 'POST', headers, body: payload, signal },
        policy,
      );
      let failure: Failure;
      let wait: number | undefined;
      if (!sent.ok) {
        failure = egressFailure(sent.error);
      } else if (sent.value.status < 200 || sent.value.status > 299) {
        failure = statusFailure(sent.value.status);
        wait = retryAfterMs(sent.value.headers);
      } else {
        const encoding = sent.value.headers.get('content-encoding');
        const read =
          encoding !== null && encoding.toLowerCase() !== 'identity'
            ? badOutput('malformed')
            : format.read(sent.value.body);
        if (read.ok) {
          const answer = read.value;
          const durationMs = Math.round(performance.now() - started);
          if (answer.usage === undefined) {
            quietly(() => {
              deps.logger.warn('ai.usage_missing', context);
            });
          }
          quietly(() => {
            deps.logger.info('ai.model_call', {
              ...context,
              attempts: attempt,
              durationMs,
              stopReason: answer.stopReason,
              ...answer.usage,
            });
          });
          quietly(() =>
            deps.metrics?.increment('ai_model_calls_total', { ...labels, outcome: 'ok' }),
          );
          quietly(() => deps.metrics?.observe('ai_model_call_duration_ms', durationMs, labels));
          return {
            ok: true,
            value: { ...answer, model, attempts: attempt },
          };
        }
        failure = read.error;
      }

      if (!RETRYABLE.has(failure.cause) || attempt >= attemptsAllowed) {
        return finish(failure, attempt);
      }
      if (wait !== undefined && wait > BACKOFF_CAP_MS) return finish(failure, attempt);
      // Full jitter, so callers that failed together do not come back together.
      const backoff =
        wait ??
        Math.floor(random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1)));
      quietly(() => {
        deps.logger.info('ai.model_call_retry', {
          ...context,
          attempt,
          cause: failure.cause,
          delayMs: backoff,
        });
      });
      try {
        await sleep(backoff, signal);
      } catch {
        return finish(fail('model.timeout', 'aborted'), attempt);
      }
    }
  }

  return Object.freeze({ kind: format.kind, complete });
}
