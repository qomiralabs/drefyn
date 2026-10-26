// Test helpers. Production code never imports this entry point.
import type { InMemoryFlagConfiguration as SdkInMemoryFlagConfiguration } from '@openfeature/server-sdk';
import type { FlagClient } from './client.ts';
import type { FlagEnv } from './config.ts';
import type { FlagRegistry, NameOf } from './definitions.ts';
import { notImplemented } from './errors.ts';
import type { Flags } from './registry.ts';

export type InMemoryFlagConfiguration = SdkInMemoryFlagConfiguration;

export interface TestFlagClientOptions<R extends FlagRegistry = Flags> {
  // Defaults to process.env.
  readonly env?: FlagEnv;
  readonly registry?: R;
}

// DREFYN_RELEASE_FLAGS: 'on' turns every release flag on, 'off' turns every one off, unset
// gives the production defaults. Kill switches and experiments are the same in all three.
export function releaseFlagsFromEnv(
  env?: FlagEnv,
  registry?: FlagRegistry,
): InMemoryFlagConfiguration {
  return notImplemented('releaseFlagsFromEnv', env, registry);
}

export function createTestFlagClient<const R extends FlagRegistry = Flags>(
  overrides?: Partial<Record<NameOf<R>, boolean>>,
  options?: TestFlagClientOptions<R>,
): FlagClient<R> {
  return notImplemented('createTestFlagClient', overrides, options);
}
