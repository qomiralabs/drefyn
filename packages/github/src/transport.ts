import {
  guardedFetch,
  policyFor,
  type EgressError,
  type EgressErrorCode,
  type EgressPolicy,
  type GuardedRequestInit,
  type GuardedResponse,
  type Result,
} from '@drefyn/egress';
import type { GitHubAppConfig } from './config.ts';

// The one way this package reaches GitHub. Production passes guardedFetch; tests pass a fake
// with the same shape, or nothing and a fake GitHub on loopback.
export type GitHubTransport = (
  url: string,
  init: GuardedRequestInit,
  policy: EgressPolicy,
) => Promise<Result<GuardedResponse, EgressError>>;

export const defaultTransport: GitHubTransport = guardedFetch;

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 200;
const BACKOFF_CAP_MS = 2000;
const API_VERSION = '2022-11-28';

// Failures worth a second try: the request may not have reached GitHub, or GitHub said so.
const TRANSIENT_EGRESS: ReadonlySet<EgressErrorCode> = new Set([
  'egress.dns_failed',
  'egress.connect_timeout',
  'egress.network_failed',
  'egress.timeout',
]);
const TRANSIENT_STATUS: ReadonlySet<number> = new Set([500, 502, 503, 504]);

// The guard's GitHub policy, narrowed to the one port the configured API listens on.
export function githubPolicy(
  config: Pick<GitHubAppConfig, 'apiUrl' | 'allowPrivateCidrs' | 'callTimeoutMs'>,
): EgressPolicy {
  const base = policyFor('github', { allowPrivateCidrs: config.allowPrivateCidrs });
  const port = new URL(config.apiUrl).port;
  return Object.freeze({
    ...base,
    ports: [port === '' ? 443 : Number(port)],
    totalTimeoutMs: config.callTimeoutMs,
  });
}

export interface CallInput {
  readonly method: 'POST' | 'DELETE';
  readonly url: string;
  readonly authorization: string;
  readonly body?: unknown;
  readonly maxResponseBytes: number;
  readonly signal: AbortSignal | undefined;
}

export type CallOutcome =
  | { readonly kind: 'response'; readonly response: GuardedResponse; readonly attempts: number }
  | { readonly kind: 'failed'; readonly egress: EgressErrorCode; readonly attempts: number };

export interface CallDeps {
  readonly transport: GitHubTransport;
  readonly policy: EgressPolicy;
  readonly random: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

// Both calls this package makes are safe to repeat: a second mint only makes a second token
// that expires on its own, and a second revoke of a revoked token changes nothing. So both
// retry, three tries at most with full jitter.
export async function callGitHub(deps: CallDeps, input: CallInput): Promise<CallOutcome> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    authorization: input.authorization,
    'user-agent': 'drefyn',
    'x-github-api-version': API_VERSION,
  };
  if (input.body !== undefined) headers['content-type'] = 'application/json';
  const init: GuardedRequestInit = {
    method: input.method,
    headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
  const policy = { ...deps.policy, maxResponseBytes: input.maxResponseBytes };
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const result = await deps.transport(input.url, init, policy);
    const outcome: CallOutcome = result.ok
      ? { kind: 'response', response: result.value, attempts }
      : { kind: 'failed', egress: result.error.code, attempts };
    const transient = result.ok
      ? TRANSIENT_STATUS.has(result.value.status)
      : TRANSIENT_EGRESS.has(result.error.code);
    if (!transient || attempts >= MAX_ATTEMPTS || input.signal?.aborted === true) return outcome;
    const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempts - 1));
    await deps.sleep(Math.floor(deps.random() * ceiling));
  }
}
