// Checked by `pnpm typecheck`: each @ts-expect-error fails the build if the line below it
// starts to compile. The function body never runs; vitest only confirms the file loads.
import { describe, expectTypeOf, it } from 'vitest';
import type { EngineErrorCode, NodeFamily, NodeLifecycle, Origin } from '../../src/index.ts';

function compileOnly(): readonly string[] {
  // @ts-expect-error a customer type is a row, never a family
  const family: NodeFamily = 'blog_post';
  // @ts-expect-error deleted is deleted_at, not a lifecycle state
  const lifecycle: NodeLifecycle = 'deleted';
  // @ts-expect-error not a place a version comes from
  const origin: Origin = 'webhook';
  // @ts-expect-error codes carry the engine prefix
  const code: EngineErrorCode = 'not_found';
  return [family, lifecycle, origin, code];
}

describe('the engine unions', () => {
  it('are the literal values, not string', () => {
    expectTypeOf<NodeFamily>().not.toEqualTypeOf<string>();
    expectTypeOf<NodeLifecycle>().not.toEqualTypeOf<string>();
    expectTypeOf<Origin>().not.toEqualTypeOf<string>();
    expectTypeOf<EngineErrorCode>().not.toEqualTypeOf<string>();
    expectTypeOf(compileOnly).toBeFunction();
  });
});
