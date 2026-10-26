// Test helpers. Production code never imports this entry point.
import {
  TypedInMemoryProvider,
  type InMemoryFlagConfiguration as SdkInMemoryFlagConfiguration,
} from '@openfeature/server-sdk';
import type { FlagClient, FlagContext, FlagEvaluation } from './client.ts';
import type { FlagEnv } from './config.ts';
import type { FlagDefinition, FlagRegistry, NameOf, PlanNameOf } from './definitions.ts';
import { FlagError } from './errors.ts';
import { flags, type Flags } from './registry.ts';

export type InMemoryFlagConfiguration = SdkInMemoryFlagConfiguration;

export interface TestFlagClientOptions<R extends FlagRegistry = Flags> {
  // Defaults to process.env.
  readonly env?: FlagEnv;
  readonly registry?: R;
}

const VARIANTS = { on: true, off: false } as const;

function releaseMode(env: FlagEnv): 'on' | 'off' | undefined {
  const value = env['DREFYN_RELEASE_FLAGS'];
  if (value === undefined || value === '') return undefined;
  if (value === 'on' || value === 'off') return value;
  // A typo in a CI variable must not quietly run the defaults.
  throw new FlagError('FLAG_CONFIG_INVALID', { key: 'DREFYN_RELEASE_FLAGS' });
}

// DREFYN_RELEASE_FLAGS: 'on' turns every release flag on, 'off' turns every one off, unset
// gives the production defaults. Kill switches and experiments are the same in all three:
// the registry holds no state, so their safe value is the only production default it knows.
export function releaseFlagsFromEnv(
  env: FlagEnv = process.env,
  registry: FlagRegistry = flags,
): InMemoryFlagConfiguration {
  const mode = releaseMode(env);
  const config: InMemoryFlagConfiguration = {};
  for (const flag of registry) {
    if (flag.kind === 'plan') continue;
    const on = flag.kind === 'release' && mode === 'on' ? true : flag.safeValue;
    config[flag.name] = { variants: VARIANTS, defaultVariant: on ? 'on' : 'off', disabled: false };
  }
  return config;
}

export function createTestFlagClient<const R extends FlagRegistry = Flags>(
  overrides: Partial<Record<NameOf<R>, boolean>> = {},
  options: TestFlagClientOptions<R> = {},
): FlagClient<R> {
  const registry: FlagRegistry = options.registry ?? flags;
  const definitions = new Map<string, FlagDefinition>(registry.map((flag) => [flag.name, flag]));
  const forced = new Map<string, boolean>();
  for (const [name, value] of Object.entries<boolean | undefined>(overrides)) {
    if (!definitions.has(name) || typeof value !== 'boolean') {
      throw new FlagError('FLAG_DEFINITION_INVALID', { flag: name });
    }
    forced.set(name, value);
  }
  const provider = new TypedInMemoryProvider(releaseFlagsFromEnv(options.env, registry));

  async function evaluate(name: string, ctx: FlagContext): Promise<FlagEvaluation> {
    const definition = definitions.get(name);
    if (definition === undefined)
      return { value: false, source: 'safe_value', errorCode: 'FLAG_NOT_FOUND' };
    const value = forced.get(name);
    if (value !== undefined) return { value, source: 'test_override' };
    // No entitlements here: a plan flag without an override is off, as when its lookup fails.
    if (definition.kind === 'plan') return { value: false, source: 'safe_value' };
    const result = await provider.resolveBooleanEvaluation(name, definition.safeValue, {
      targetingKey: ctx.organizationId,
    });
    return { value: result.value, source: 'provider' };
  }

  return {
    isOn: (name: Exclude<NameOf<R>, PlanNameOf<R>>, ctx: FlagContext) =>
      evaluate(name, ctx).then((result) => result.value),
    evaluate: (name: NameOf<R>, ctx: FlagContext) => evaluate(name, ctx),
    close: () => Promise.resolve(),
  };
}
