// Checked by tsc through pnpm typecheck. The runtime part only proves the file loads.
import type { AccessContext } from '@drefyn/auth';
import { describe, expectTypeOf, it } from 'vitest';
import { findProject, mayRead, projectsOf } from '../src/fixtures/projects.ts';
import * as real from '../src/server/projects.ts';

describe('data functions', () => {
  it('cannot be called without an AccessContext', () => {
    expectTypeOf(findProject).parameter(0).toEqualTypeOf<AccessContext>();
    // Never called: only tsc judges these lines.
    const typeOnly = (organizationId: string) => {
      // @ts-expect-error a product is not an access context
      findProject('docs', 'payments-api');
      // @ts-expect-error a product is not an access context
      projectsOf('docs');
      // @ts-expect-error a product is not an access context
      mayRead('docs');
      // @ts-expect-error a look alike has no brand, so only the guard can make one
      findProject({ organizationId, permissions: ['docs.read'] }, 'docs', 'payments-api');
      // @ts-expect-error the real read needs an access context too
      void real.findProject('docs', 'payments-api');
      // @ts-expect-error the real read needs an access context too
      void real.projectsOf('docs');
      // @ts-expect-error a look alike has no brand, so only the guard can make one
      void real.projectsInReach({ organizationId, permissions: ['docs.read'] });
    };
    expectTypeOf(typeOnly).toBeFunction();
  });
});
