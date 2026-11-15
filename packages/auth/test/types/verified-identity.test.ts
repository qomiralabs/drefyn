// Checked by tsc through pnpm typecheck. The runtime part only proves the file loads.
import { idOf, organizationId } from '@drefyn/tenancy';
import { describe, expectTypeOf, it } from 'vitest';
import type { SsoCompleted, SsoRefusal, VerifiedIdentity } from '../../src/index.ts';

describe('VerifiedIdentity', () => {
  it('cannot be written as a value outside the module that mints it', () => {
    const claimed = {
      protocol: 'oidc',
      organizationId: organizationId('01a14984-4476-77ce-9335-12800000c001'),
      connectionId: idOf('ssc', '01a14984-4476-77ce-9335-12800000c002'),
      subject: 'someone',
      email: 'ceo@victim.example',
      displayName: null,
      idpAuthenticatedAt: new Date(),
    } as const;
    // @ts-expect-error the brand key is a symbol only the minting module holds
    const forged: VerifiedIdentity = claimed;
    // @ts-expect-error not even with a brand of its own
    const branded: VerifiedIdentity = { ...claimed, [Symbol('verified identity')]: true };
    expectTypeOf([forged, branded]).toBeArray();
  });

  it('names the three refusals and the four outcomes', () => {
    expectTypeOf<SsoRefusal>().toEqualTypeOf<
      'AUTH_SSO_SEAT_LIMIT' | 'AUTH_SSO_NOT_PROVISIONED' | 'AUTH_SSO_SIGNUP_CLOSED'
    >();
    expectTypeOf<SsoCompleted['kind']>().toEqualTypeOf<
      'signed_in' | 'factor_required' | 'link_code_sent' | 'refused'
    >();
  });
});
