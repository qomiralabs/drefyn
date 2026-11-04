// Checked by tsc. A kind, purpose, provider or invitation field added on either side fails
// the build here until the adapter handles it.
import type {
  AuthSecurityNotice,
  InvitationSend,
  OAuthProvider,
  SignInCodePurpose,
} from '@drefyn/auth';
import type {
  InvitationMail,
  LinkProvider,
  SecurityNoticeKind,
  SignInCodePurpose as MailPurpose,
} from '@drefyn/email';
import { describe, expectTypeOf, it } from 'vitest';

// The fields of an invitation that only say which row a send belongs to; they become the
// idempotency key and the tenant, not words in the mail.
type KeyFields = 'organizationId' | 'invitationId' | 'sendCount';

describe('auth and mail agree', () => {
  it('on every notice kind', () => {
    expectTypeOf<AuthSecurityNotice['kind']>().toEqualTypeOf<SecurityNoticeKind>();
  });

  it('on every sign in code purpose', () => {
    expectTypeOf<SignInCodePurpose>().toEqualTypeOf<MailPurpose>();
  });

  it('on every provider', () => {
    expectTypeOf<OAuthProvider>().toEqualTypeOf<LinkProvider>();
  });

  it('on every invitation field, so none is dropped', () => {
    expectTypeOf<Exclude<keyof InvitationSend, KeyFields>>().toEqualTypeOf<
      Exclude<keyof InvitationMail, 'template'>
    >();
  });
});
