import type { FeatureKey } from '@drefyn/entitlements';
import type { OrganizationId, ProjectId } from '@drefyn/tenancy';
import { randomUUID } from 'node:crypto';
import { FlagdProvider } from '@openfeature/flagd-provider';
import {
  ErrorCode,
  NOOP_PROVIDER,
  OpenFeature,
  ProviderEvents,
  ProviderStatus,
  type Client,
  type EvaluationContext,
  type Logger,
  type Provider,
} from '@openfeature/server-sdk';
import { assertFlagConfig, DEFAULT_FLAGD_SYNC_PORT, type FlagConfig } from './config.ts';
import type { FlagDefinition, FlagRegistry, NameOf, PlanFlag, PlanNameOf } from './definitions.ts';
import { flags, type Flags } from './registry.ts';

export interface FlagContext {
  // The targeting key, so a fractional rollout keeps an organization in or out.
  readonly organizationId: OrganizationId;
  readonly projectId?: ProjectId;
  readonly userId?: string;
  // Internal organizations, for the rollout ladder.
  readonly internal?: boolean;
}

export type FlagSource = 'provider' | 'safe_value' | 'test_override' | 'entitlements';

export type FlagEvaluationErrorCode =
  | 'FLAG_TIMEOUT'
  | 'FLAG_PROVIDER_NOT_READY'
  | 'FLAG_NOT_FOUND'
  | 'FLAG_PARSE_ERROR'
  | 'FLAG_GENERAL';

export interface FlagEvaluation {
  readonly value: boolean;
  readonly source: FlagSource;
  readonly errorCode?: FlagEvaluationErrorCode;
}

export interface FlagClient<R extends FlagRegistry = Flags> {
  // Plan flags are left out: ask entitlements, or use evaluate to see the source.
  isOn(name: Exclude<NameOf<R>, PlanNameOf<R>>, ctx: FlagContext): Promise<boolean>;
  evaluate(name: NameOf<R>, ctx: FlagContext): Promise<FlagEvaluation>;
  close(): Promise<void>;
}

// What plan flags read. The caller adapts its tier lookup plus hasFeature to this.
export interface EntitlementsReader {
  hasFeature(organizationId: OrganizationId, feature: FeatureKey): Promise<boolean>;
}

export type LogFields = Readonly<Record<string, string | number | boolean>>;

export interface FlagLogger {
  warn(event: string, fields?: LogFields): void;
}

export type MetricLabels = Readonly<Record<string, string>>;

export interface FlagMetrics {
  gauge(
    name: 'flags_provider_ready' | 'flags_last_sync_age_seconds',
    value: number,
    labels?: MetricLabels,
  ): void;
  histogram(name: 'flags_evaluation_ms', value: number, labels?: MetricLabels): void;
}

export interface FlagClientDeps<R extends FlagRegistry = Flags> {
  readonly entitlements: EntitlementsReader;
  // Defaults to the package registry; tests pass their own.
  readonly registry?: R;
  readonly logger?: FlagLogger;
  readonly metrics?: FlagMetrics;
}

type ProviderOptions = NonNullable<ConstructorParameters<typeof FlagdProvider>[0]>;

// How often the sync age and ready gauges are pushed while the client is open.
export const SYNC_AGE_INTERVAL_MS = 15_000;

// The flagd provider fills every option it is not given from FLAGD_* variables, the
// resolver, file and socket included. So every option is set here, undefined on purpose
// where a value would change the source, and nothing from the host can move it.
function providerOptions(config: FlagConfig): ProviderOptions {
  const pinned: Record<string, unknown> = {
    resolverType: 'in-process',
    host: config.source === 'flagd' ? config.host : 'localhost',
    port: config.source === 'flagd' ? config.syncPort : DEFAULT_FLAGD_SYNC_PORT,
    offlineFlagSourcePath: config.source === 'file' ? config.file : undefined,
    socketPath: undefined,
    tls: false,
    certPath: undefined,
    selector: '',
    defaultAuthority: undefined,
    deadlineMs: 500,
    streamDeadlineMs: 600_000,
    keepAliveTime: 0,
    retryBackoffMs: 1000,
    retryBackoffMaxMs: 5000,
    retryGracePeriod: 10,
    fatalStatusCodes: [],
    cache: 'disabled',
    maxCacheSize: 1000,
  };
  return pinned;
}

function fallback(value: boolean, errorCode: FlagEvaluationErrorCode): FlagEvaluation {
  return { value, source: 'safe_value', errorCode };
}

function fromErrorCode(code: ErrorCode): FlagEvaluationErrorCode {
  switch (code) {
    case ErrorCode.FLAG_NOT_FOUND:
      return 'FLAG_NOT_FOUND';
    case ErrorCode.PARSE_ERROR:
    case ErrorCode.TYPE_MISMATCH:
      return 'FLAG_PARSE_ERROR';
    // Fatal means it will never answer, which a caller handles the same as not ready yet.
    case ErrorCode.PROVIDER_NOT_READY:
    case ErrorCode.PROVIDER_FATAL:
      return 'FLAG_PROVIDER_NOT_READY';
    default:
      return 'FLAG_GENERAL';
  }
}

const ERROR_CODES: ReadonlySet<unknown> = new Set(Object.values(ErrorCode));

// What the SDK would report for a thrown error: its OpenFeature code, or general.
// Reading the code can itself throw (a getter, a proxy trap), and must not.
function codeOf(error: unknown): ErrorCode {
  try {
    const code: unknown =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    return ERROR_CODES.has(code) ? (code as ErrorCode) : ErrorCode.GENERAL;
  } catch {
    return ErrorCode.GENERAL;
  }
}

// A provider can hand back anything, so a string 'true' or a missing result must not pass
// as on. Only a real boolean from a result without an error code is used.
function fromResolution(resolution: unknown, safe: boolean): FlagEvaluation {
  try {
    if (typeof resolution !== 'object' || resolution === null) {
      return fallback(safe, 'FLAG_PARSE_ERROR');
    }
    const { value, errorCode } = resolution as { value?: unknown; errorCode?: unknown };
    if (errorCode !== undefined && errorCode !== null) {
      return fallback(safe, fromErrorCode(codeOf({ code: errorCode })));
    }
    if (typeof value !== 'boolean') return fallback(safe, 'FLAG_PARSE_ERROR');
    return { value, source: 'provider' };
  } catch {
    return fallback(safe, 'FLAG_GENERAL');
  }
}

// Provider log lines are free text that can carry context values, so none are kept.
// Stale and error keep answering, since the in process provider serves its last synced
// values. Any other status, including one a later SDK adds, fails closed.
const USABLE_STATUSES: ReadonlySet<unknown> = new Set([
  ProviderStatus.READY,
  ProviderStatus.STALE,
  ProviderStatus.ERROR,
]);

const SILENT: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
};

// The work promise never rejects; whichever settles first wins and the timer is cleared.
function withTimeout(
  work: Promise<FlagEvaluation>,
  ms: number,
  onTimeout: FlagEvaluation,
): Promise<FlagEvaluation> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(onTimeout);
    }, ms);
    void work.then((result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

function toContext(ctx: FlagContext): EvaluationContext {
  const context: EvaluationContext = {
    targetingKey: ctx.organizationId,
    organizationId: ctx.organizationId,
  };
  if (ctx.projectId !== undefined) context['projectId'] = ctx.projectId;
  if (ctx.userId !== undefined) context['userId'] = ctx.userId;
  // Always set: left out, a global OpenFeature context could turn internal rollout on.
  context['internal'] = ctx.internal === true;
  return Object.freeze(context);
}

type ProviderFlag = Exclude<FlagDefinition, PlanFlag>;

class ProviderFlagClient<R extends FlagRegistry> implements FlagClient<R> {
  private readonly definitions = new Map<string, FlagDefinition>();
  private readonly startedAt = Date.now();
  // When the client last knew its values matched the source; undefined while connected.
  private outOfSyncSince: number | undefined = this.startedAt;
  private everReady = false;
  // Until the start wait ends, losses are not logged: the start reports its own reason.
  private starting = true;
  private notReadyLogged = false;
  private closed = false;
  private readonly ticker: ReturnType<typeof setInterval>;
  private readonly labels: MetricLabels;
  private readonly handlers: [ProviderEvents, () => void][];

  private readonly config: FlagConfig;
  private readonly domain: string;
  private readonly client: Client;
  private readonly provider: Provider;
  private readonly deps: FlagClientDeps<R>;

  constructor(
    config: FlagConfig,
    domain: string,
    client: Client,
    provider: Provider,
    registry: FlagRegistry,
    deps: FlagClientDeps<R>,
  ) {
    this.config = config;
    this.domain = domain;
    this.client = client;
    this.provider = provider;
    this.deps = deps;
    for (const definition of registry) this.definitions.set(definition.name, definition);
    this.labels = { source: config.source };
    const synced = () => {
      this.markReady();
    };
    const lost = () => {
      this.markLost();
    };
    this.handlers = [
      [ProviderEvents.Ready, synced],
      [ProviderEvents.ConfigurationChanged, synced],
      [ProviderEvents.Stale, lost],
      [ProviderEvents.Error, lost],
    ];
    for (const [event, handler] of this.handlers) client.addHandler(event, handler);
    this.ticker = setInterval(() => {
      this.pushGauges();
    }, SYNC_AGE_INTERVAL_MS);
    this.ticker.unref();
  }

  isOn(name: Exclude<NameOf<R>, PlanNameOf<R>>, ctx: FlagContext): Promise<boolean> {
    return this.evaluate(name, ctx).then((result) => result.value);
  }

  async evaluate(name: NameOf<R>, ctx: FlagContext): Promise<FlagEvaluation> {
    const started = performance.now();
    const definition = this.definitions.get(name);
    let result: FlagEvaluation;
    if (definition === undefined) result = fallback(false, 'FLAG_NOT_FOUND');
    else if (definition.kind === 'plan') result = await this.fromEntitlements(definition, ctx);
    else result = await this.fromProvider(definition, ctx);
    const labels: Record<string, string> = {
      flag: definition === undefined ? 'unregistered' : definition.name,
      source: result.source,
    };
    if (result.errorCode !== undefined) labels['error'] = result.errorCode;
    this.histogram(performance.now() - started, labels);
    return result;
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    clearInterval(this.ticker);
    for (const [event, handler] of this.handlers) this.client.removeHandler(event, handler);
    // Swapping the domain to the no-op provider makes the SDK close ours exactly once and
    // leaves nothing in the global registry pointing at a closed provider. The SDK does not
    // await that close; the patched provider stops its gRPC sync from reconnecting anyway.
    OpenFeature.setProvider(this.domain, NOOP_PROVIDER);
    return Promise.resolve();
  }

  // Called once the start wait is over, whichever way it ended.
  started(outcome: 'ready' | 'failed' | 'timeout'): void {
    this.starting = false;
    if (outcome === 'ready') this.markReady();
    else this.markLost(outcome);
  }

  private fromProvider(definition: ProviderFlag, ctx: FlagContext): Promise<FlagEvaluation> {
    const safe = definition.safeValue;
    // Before the first sync the provider has nothing of ours to answer from.
    if (this.closed || !this.everReady || !this.providerUsable()) {
      return Promise.resolve(fallback(safe, 'FLAG_PROVIDER_NOT_READY'));
    }
    let work: Promise<FlagEvaluation>;
    try {
      // Straight to our own provider, not through the OpenFeature client. Any code in the
      // process can add API or client hooks, and the provider adds its own: before hooks
      // can rewrite or add context keys, and after and finally hooks can rewrite the
      // answer. Nothing a hook does can then move a flag across organizations. The API
      // and transaction contexts are left out too: the caller's context is the whole
      // context.
      work = this.provider
        .resolveBooleanEvaluation(definition.name, safe, toContext(ctx), SILENT)
        .then(
          (resolution) => fromResolution(resolution, safe),
          (error: unknown) => fallback(safe, fromErrorCode(codeOf(error))),
        );
    } catch (error) {
      return Promise.resolve(fallback(safe, fromErrorCode(codeOf(error))));
    }
    return withTimeout(work, this.config.evalTimeoutMs, fallback(safe, 'FLAG_TIMEOUT'));
  }

  // The client reports the status of whatever provider the domain points at. Once the
  // domain is cleared or rebound that is someone else's provider, so ours stops answering.
  private providerUsable(): boolean {
    try {
      if (OpenFeature.getProvider(this.domain) !== this.provider) return false;
      return USABLE_STATUSES.has(this.client.providerStatus);
    } catch {
      return false;
    }
  }

  // Plan flags fail closed: a broken lookup must not give a paid feature away.
  private fromEntitlements(definition: PlanFlag, ctx: FlagContext): Promise<FlagEvaluation> {
    if (this.closed) return Promise.resolve(fallback(false, 'FLAG_PROVIDER_NOT_READY'));
    let answer: Promise<unknown>;
    try {
      answer = Promise.resolve(
        this.deps.entitlements.hasFeature(ctx.organizationId, definition.feature),
      );
    } catch {
      return Promise.resolve(fallback(false, 'FLAG_GENERAL'));
    }
    const work = answer.then(
      (value): FlagEvaluation =>
        typeof value === 'boolean'
          ? { value, source: 'entitlements' }
          : fallback(false, 'FLAG_PARSE_ERROR'),
      () => fallback(false, 'FLAG_GENERAL'),
    );
    return withTimeout(work, this.config.evalTimeoutMs, fallback(false, 'FLAG_TIMEOUT'));
  }

  private markReady(): void {
    if (this.closed) return;
    this.everReady = true;
    this.outOfSyncSince = undefined;
    this.pushGauges();
  }

  private markLost(reason: 'failed' | 'timeout' | 'lost' = 'lost'): void {
    if (this.closed) return;
    this.outOfSyncSince ??= Date.now();
    if (!this.everReady && !this.starting && !this.notReadyLogged) {
      this.notReadyLogged = true;
      this.warn('flags.provider_not_ready', {
        source: this.config.source,
        reason,
        waited_ms: Date.now() - this.startedAt,
      });
    }
    this.pushGauges();
  }

  private pushGauges(): void {
    const since = this.outOfSyncSince;
    const age = since === undefined ? 0 : Math.max(0, Math.floor((Date.now() - since) / 1000));
    this.gauge('flags_provider_ready', since === undefined ? 1 : 0);
    this.gauge('flags_last_sync_age_seconds', age);
  }

  // A broken sink must never break an evaluation or a start.
  private gauge(name: 'flags_provider_ready' | 'flags_last_sync_age_seconds', value: number) {
    try {
      this.deps.metrics?.gauge(name, value, this.labels);
    } catch {
      // Metrics are best effort.
    }
  }

  private histogram(ms: number, labels: MetricLabels): void {
    try {
      this.deps.metrics?.histogram('flags_evaluation_ms', ms, labels);
    } catch {
      // Metrics are best effort.
    }
  }

  private warn(event: string, fields: LogFields): void {
    try {
      this.deps.logger?.warn(event, fields);
    } catch {
      // Logging is best effort.
    }
  }
}

function waitForStart(ready: Promise<void>, ms: number): Promise<'ready' | 'failed' | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve('timeout');
    }, ms);
    ready.then(
      () => {
        clearTimeout(timer);
        resolve('ready');
      },
      () => {
        clearTimeout(timer);
        resolve('failed');
      },
    );
  });
}

// Never rejects for an unreachable provider: it waits at most the init timeout and then
// serves safe values until the provider is ready. Only an invalid config rejects.
export async function createFlagClient<const R extends FlagRegistry = Flags>(
  config: FlagConfig,
  deps: FlagClientDeps<R>,
): Promise<FlagClient<R>> {
  assertFlagConfig(config);
  const provider = new FlagdProvider(providerOptions(config));
  // Random, so it cannot collide with another client's domain. It is not a secret: API
  // level event handlers receive it. A domain rebound to another provider fails closed.
  const domain = `drefyn-flags-${randomUUID()}`;
  // Registers the provider synchronously; the promise settles when its start does.
  const ready = OpenFeature.setProviderAndWait(domain, provider);
  const client = OpenFeature.getClient(domain);
  const flagClient = new ProviderFlagClient<R>(
    config,
    domain,
    client,
    provider,
    deps.registry ?? flags,
    deps,
  );
  flagClient.started(await waitForStart(ready, config.initTimeoutMs));
  return flagClient;
}
