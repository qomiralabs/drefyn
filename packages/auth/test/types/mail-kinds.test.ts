// Checked by `pnpm typecheck`. Auth's source imports nothing from the mail package, so a new
// notice kind, purpose or provider here is what fails the build until mail has a template.
import type { AuthSecurityNotice, OAuthProvider, SignInCodePurpose } from '../../src/index.ts';
import type {
  LinkProvider,
  SecurityNoticeKind,
  SignInCodePurpose as MailPurpose,
} from '@drefyn/email';
import { describe, expectTypeOf, it } from 'vitest';

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
});
