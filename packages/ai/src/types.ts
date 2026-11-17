import type { TokenUsage } from '@drefyn/credits';
import type { OrganizationId, ProjectId, TenantRef } from '@drefyn/tenancy';

export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const MODEL_ERROR_CODES = Object.freeze([
  'model.not_configured',
  'model.timeout',
  'model.overloaded',
  'model.refused',
  'model.bad_output',
] as const);
export type ModelErrorCode = (typeof MODEL_ERROR_CODES)[number];

// The detail under a code, for logs and for the few callers that word a message by it.
// Callers decide refunds and retries by the code alone.
export const MODEL_ERROR_CAUSES = Object.freeze([
  // model.not_configured
  'unset',
  'paused',
  'endpoint_denied',
  // model.timeout
  'timeout',
  'aborted',
  // model.overloaded
  'unreachable',
  'rate_limited',
  'overloaded',
  'server_error',
  // model.refused
  'auth',
  'not_found',
  'bad_request',
  'refusal',
  'content_filter',
  // model.bad_output
  'malformed',
  'empty',
  'unexpected_stop',
  'too_large',
] as const);
export type ModelErrorCause = (typeof MODEL_ERROR_CAUSES)[number];

export interface ModelError {
  readonly code: ModelErrorCode;
  readonly cause: ModelErrorCause;
  /** The HTTP status, when the provider answered with an error status. */
  readonly status?: number;
  /** Requests sent, 0 when none was. */
  readonly attempts: number;
}

export type ModelProviderKind = 'anthropic' | 'openai_compatible';

export interface ModelMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export interface ModelRequest {
  /** Goes into every log line and metric; never sent to the provider. */
  readonly tenant: TenantRef;
  /** Defaults to the provider's configured model. */
  readonly model?: string;
  readonly system?: string;
  /** Marks the system text for the provider's prompt cache, where it has one. */
  readonly cacheSystem?: boolean;
  readonly messages: readonly ModelMessage[];
  readonly maxOutputTokens: number;
}

export type StopReason = 'end' | 'max_tokens';

export interface ModelResponse {
  readonly text: string;
  /** The model asked for, which is what a call is priced on. */
  readonly model: string;
  readonly stopReason: StopReason;
  /** Integer token counts for settlement; undefined when the endpoint reported none we trust. */
  readonly usage: TokenUsage | undefined;
  readonly attempts: number;
}

export interface ModelProvider {
  readonly kind: ModelProviderKind | 'none';
  /**
   * One model call. Every outcome the provider or the network can cause comes back as a
   * Result; only a request no caller should build (no messages, a bad output cap or model
   * name) rejects.
   */
  complete(request: ModelRequest, signal: AbortSignal): Promise<Result<ModelResponse, ModelError>>;
}

export type LogFields = Readonly<Record<string, string | number | boolean>>;

export interface ModelLogger {
  info(event: string, fields: LogFields): void;
  warn(event: string, fields: LogFields): void;
}

export type MetricLabels = Readonly<Record<string, string>>;

export interface ModelMetrics {
  increment(name: 'ai_model_calls_total', labels: MetricLabels): void;
  observe(name: 'ai_model_call_duration_ms', value: number, labels: MetricLabels): void;
}

// The part of the flag client this needs, so a FlagClient fits as it is.
export interface ModelCallGate {
  isOn(
    name: 'ai.model_calls',
    ctx: { readonly organizationId: OrganizationId; readonly projectId?: ProjectId },
  ): Promise<boolean>;
}

export interface ModelDeps {
  readonly gate: ModelCallGate;
  readonly logger: ModelLogger;
  readonly metrics?: ModelMetrics;
  /** Jitter source in [0, 1). Defaults to Math.random. */
  readonly random?: () => number;
  /** Backoff wait; rejects when the signal fires. Defaults to a timer. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}
