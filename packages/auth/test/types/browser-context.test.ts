// Checked by tsc through pnpm typecheck. The runtime part only proves the file loads.
import { describe, expectTypeOf, it } from 'vitest';
import type { BrowserContext } from '../../src/index.ts';

describe('BrowserContext', () => {
  it('holds nothing a URL could be built from', () => {
    expectTypeOf<Extract<keyof BrowserContext, 'url' | 'host' | 'headers'>>().toBeNever();
    const typeOnly = (b: BrowserContext) => [
      // @ts-expect-error absolute URLs come only from the configured origin
      b.url,
      // @ts-expect-error absolute URLs come only from the configured origin
      b.host,
      // @ts-expect-error absolute URLs come only from the configured origin
      b.headers,
    ];
    expectTypeOf(typeOnly).toBeFunction();
  });
});
