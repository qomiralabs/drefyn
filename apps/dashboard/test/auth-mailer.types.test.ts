// Checked by tsc. A kind, purpose, provider, invitation field or notice field added on either
// side fails the build here until the other side has it.
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
  SecurityNoticeMail,
  SignInCodePurpose as MailPurpose,
} from '@drefyn/email';
import { describe, expectTypeOf, it } from 'vitest';

// The fields of an invitation that only say which row a send belongs to; they become the
// idempotency key and the tenant, not words in the mail.
type KeyFields = 'organizationId' | 'invitationId' | 'sendCount';

// Fields that say which row a notice is about. They become the key, the tenant and the log
// context, never words in the mail.
type RowIds = 'organizationId' | 'keyId' | 'membershipId';
type Kind = AuthSecurityNotice['kind'];

// Several kinds share one union member, so Extract on a single kind would find nothing.
type Of<Union extends { readonly kind: string }, K> = Union extends unknown
  ? K extends Union['kind']
    ? Union
    : never
  : never;

type OptionalKeys<Shape> = {
  [Field in keyof Shape]-?: Partial<Pick<Shape, Field>> extends Pick<Shape, Field> ? Field : never;
}[keyof Shape];
type AnyOptional<Union> = Union extends unknown ? OptionalKeys<Union> : never;

// The organization id is what the adapter turns into the organization name.
type AuthFields<Notice> =
  | Exclude<keyof Notice, RowIds>
  | ('organizationId' extends keyof Notice ? 'organizationName' : never);

// Every mail kind may hold the optional facts, and only some kinds fill them.
type MailFields<K extends Kind> = Exclude<
  keyof Of<SecurityNoticeMail, K>,
  Exclude<OptionalKeys<Of<SecurityNoticeMail, K>>, keyof Of<AuthSecurityNotice, K>>
>;

describe('auth and mail agree', () => {
  it('on every notice kind', () => {
    expectTypeOf<AuthSecurityNotice['kind']>().toEqualTypeOf<SecurityNoticeKind>();
  });

  it('on the fields of every notice kind', () => {
    expectTypeOf<{ [K in Kind]: AuthFields<Of<AuthSecurityNotice, K>> }>().toEqualTypeOf<{
      [K in Kind]: MailFields<K>;
    }>();
  });

  it('on the optional facts, which no kind may add alone', () => {
    expectTypeOf<AnyOptional<SecurityNoticeMail>>().toEqualTypeOf<
      Exclude<AuthFields<Of<AuthSecurityNotice, 'new_device_sign_in'>>, 'kind' | 'at'>
    >();
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
