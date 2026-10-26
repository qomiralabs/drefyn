// Stands in for @openfeature/flagd-provider. Each test file mocks the module with
// `vi.mock('@openfeature/flagd-provider', () => import('./support/flagd.ts'))`, so the
// client builds its provider exactly as in production and gets the installed fake.
import type { Provider } from '@openfeature/server-sdk';

export const flagd: { provider: Provider | undefined; options: unknown[] } = {
  provider: undefined,
  options: [],
};

export function install(provider: Provider): void {
  flagd.provider = provider;
}

export function reset(): void {
  flagd.provider = undefined;
  flagd.options.length = 0;
}

// A plain function, so `new FlagdProvider(options)` returns the installed fake.
export function FlagdProvider(options: unknown): Provider {
  flagd.options.push(options);
  if (flagd.provider === undefined) throw new Error('no fake provider installed');
  return flagd.provider;
}
