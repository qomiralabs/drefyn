// Checked by tsc through pnpm typecheck. The runtime part only proves the file loads.
import { describe, expectTypeOf, it } from 'vitest';
import type { IdOf, OrganizationId, UserId } from '@drefyn/tenancy';
import type { parseApiKey, parseInvitationToken, parseSessionToken } from '../../src/index.ts';
import { formatInvitationToken, formatSessionToken } from '../../src/index.ts';

type Parsed<F extends (value: unknown) => unknown> = NonNullable<ReturnType<F>>;

describe('credential ids carry their tenancy brands', () => {
  it('types the ids a parser returns', () => {
    expectTypeOf<Parsed<typeof parseSessionToken>['userId']>().toEqualTypeOf<UserId>();
    expectTypeOf<Parsed<typeof parseSessionToken>['sessionId']>().toEqualTypeOf<IdOf<'ses'>>();
    expectTypeOf<Parsed<typeof parseInvitationToken>['invitationId']>().toEqualTypeOf<
      IdOf<'inv'>
    >();
    expectTypeOf<
      Parsed<typeof parseInvitationToken>['organizationId']
    >().toEqualTypeOf<OrganizationId>();
    expectTypeOf<Parsed<typeof parseApiKey>['keyId']>().toEqualTypeOf<IdOf<'key'>>();
  });

  it('refuses a plain string or another kind where a session or invitation id belongs', () => {
    // Never called: the formatters validate at runtime, and only tsc judges these lines.
    const typeOnly = () => {
      const secret = new Uint8Array(32);
      const user = '' as UserId;
      const organization = '' as OrganizationId;
      // @ts-expect-error a plain string is not a session id
      formatSessionToken({ userId: user, sessionId: 'x', secret });
      // @ts-expect-error a user id is not a session id
      formatSessionToken({ userId: user, sessionId: user, secret });
      // @ts-expect-error an organization id is not an invitation id
      formatInvitationToken({ organizationId: organization, invitationId: organization, secret });
    };
    expectTypeOf(typeOnly).toBeFunction();
  });
});
