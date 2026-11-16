// Checked by tsc through pnpm typecheck. The runtime part only proves the file loads.
import { describe, expectTypeOf, it } from 'vitest';
import type { UserSchema } from '@drefyn/db';
import type { Insertable } from 'kysely';
import type { FactorKind, PendingTotpRow, StepUpMethod } from '../../src/index.ts';

describe('FactorKind', () => {
  it('is the two factor forms', () => {
    expectTypeOf<FactorKind>().toEqualTypeOf<'totp' | 'recovery_code'>();
  });

  it('stays part of StepUpMethod, so a factor step up is always a known method', () => {
    expectTypeOf<StepUpMethod>().toEqualTypeOf<
      'email' | 'password' | 'google' | 'github_session' | FactorKind
    >();
    expectTypeOf<Extract<StepUpMethod, FactorKind>>().toEqualTypeOf<FactorKind>();
  });
});

describe('PendingTotpRow', () => {
  it('fits an insert into app.totp_credentials', () => {
    expectTypeOf<PendingTotpRow>().toExtend<Insertable<UserSchema['totp_credentials']>>();
  });
});
