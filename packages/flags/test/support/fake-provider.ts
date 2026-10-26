import {
  ErrorCode,
  OpenFeatureEventEmitter,
  ProviderEvents,
  type EvaluationContext,
  type Hook,
  type JsonValue,
  type Logger,
  type Provider,
  type ResolutionDetails,
} from '@openfeature/server-sdk';

// What the fake does for one evaluation. Values are unknown on purpose: a real provider
// can hand back anything, and the client must not trust the type.
export type Behaviour =
  | { readonly kind: 'value'; readonly value: unknown; readonly reason?: string }
  // Answers from the context it was given, like a targeting rule.
  | { readonly kind: 'rule'; readonly rule: (context: EvaluationContext) => unknown }
  // Hands back this exact result, whatever its shape.
  | { readonly kind: 'raw'; readonly resolution: () => unknown }
  | { readonly kind: 'throw'; readonly error: unknown }
  | { readonly kind: 'throw_sync'; readonly error: unknown }
  | { readonly kind: 'hang' }
  | { readonly kind: 'late_value'; readonly afterMs: number; readonly value: unknown }
  | { readonly kind: 'late_throw'; readonly afterMs: number; readonly error: unknown }
  | { readonly kind: 'error_result'; readonly errorCode: ErrorCode; readonly value: unknown };

export type InitMode = 'ready' | 'hang' | 'reject' | 'none';

export interface ResolveCall {
  readonly flagKey: string;
  readonly defaultValue: unknown;
  readonly context: EvaluationContext;
  readonly logger: Logger | undefined;
}

const never = new Promise<never>(() => undefined);

// Rejects with whatever a provider might throw, Error or not.
async function fail(error: unknown): Promise<never> {
  await Promise.resolve();
  throw error as Error;
}

export class FakeProvider implements Provider {
  readonly metadata = { name: 'fake' } as const;
  readonly runsOn = 'server' as const;
  readonly events = new OpenFeatureEventEmitter();
  readonly calls: ResolveCall[] = [];
  // Provider hooks, which the SDK runs after every other before hook. The real flagd
  // provider adds one in sync mode.
  hooks: Hook[] = [];
  closed = 0;
  initialized = 0;
  fallback: Behaviour = { kind: 'error_result', errorCode: ErrorCode.FLAG_NOT_FOUND, value: false };
  private readonly behaviours = new Map<string, Behaviour>();
  private releaseInit: (() => void) | undefined;
  readonly initialize?: () => Promise<void>;

  constructor(init: InitMode = 'ready') {
    // 'none' leaves initialize undefined, which the SDK reads as ready at once.
    if (init === 'none') return;
    this.initialize = async () => {
      this.initialized += 1;
      if (init === 'reject') throw new Error('flagd unreachable');
      if (init === 'hang') {
        await new Promise<void>((resolve) => {
          this.releaseInit = resolve;
        });
      }
    };
  }

  // Lets a provider that hung at start become ready later.
  finishInit(): void {
    this.releaseInit?.();
  }

  set(flagKey: string, behaviour: Behaviour): this {
    this.behaviours.set(flagKey, behaviour);
    return this;
  }

  setAll(behaviour: Behaviour): this {
    this.behaviours.clear();
    this.fallback = behaviour;
    return this;
  }

  emit(event: ProviderEvents, errorCode?: ErrorCode): void {
    if (event === ProviderEvents.Error) {
      this.events.emit(event, { message: 'stream lost', ...(errorCode ? { errorCode } : {}) });
    } else {
      this.events.emit(event, {});
    }
  }

  callsFor(flagKey: string): ResolveCall[] {
    return this.calls.filter((call) => call.flagKey === flagKey);
  }

  onClose(): Promise<void> {
    this.closed += 1;
    return Promise.resolve();
  }

  resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
    logger?: Logger,
  ): Promise<ResolutionDetails<boolean>> {
    this.calls.push({ flagKey, defaultValue, context, logger });
    const behaviour = this.behaviours.get(flagKey) ?? this.fallback;
    // The casts are the point: providers are not trusted to return booleans.
    const details = (value: unknown, reason = 'STATIC') =>
      ({ value, reason }) as unknown as ResolutionDetails<boolean>;
    switch (behaviour.kind) {
      case 'value':
        return Promise.resolve(details(behaviour.value, behaviour.reason));
      case 'rule':
        return Promise.resolve(details(behaviour.rule(context), 'TARGETING_MATCH'));
      case 'raw':
        return Promise.resolve(behaviour.resolution() as ResolutionDetails<boolean>);
      case 'throw':
        return fail(behaviour.error);
      case 'throw_sync':
        throw behaviour.error as Error;
      case 'hang':
        return never;
      case 'late_value':
        return new Promise((resolve) =>
          setTimeout(() => {
            resolve(details(behaviour.value));
          }, behaviour.afterMs),
        );
      case 'late_throw':
        return new Promise<void>((resolve) => setTimeout(resolve, behaviour.afterMs)).then(() =>
          fail(behaviour.error),
        );
      case 'error_result':
        return Promise.resolve({
          value: behaviour.value,
          reason: 'ERROR',
          errorCode: behaviour.errorCode,
        } as unknown as ResolutionDetails<boolean>);
    }
  }

  resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
  ): Promise<ResolutionDetails<string>> {
    return Promise.reject(
      new Error(`fake resolves booleans only, asked for ${flagKey} ${defaultValue}`),
    );
  }

  resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
  ): Promise<ResolutionDetails<number>> {
    return Promise.reject(
      new Error(`fake resolves booleans only, asked for ${flagKey} ${String(defaultValue)}`),
    );
  }

  resolveObjectEvaluation<T extends JsonValue>(flagKey: string): Promise<ResolutionDetails<T>> {
    return Promise.reject(new Error(`fake resolves booleans only, asked for ${flagKey}`));
  }
}
