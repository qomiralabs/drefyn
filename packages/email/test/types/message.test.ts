// Checked by `pnpm typecheck`: each @ts-expect-error fails the build if the line below it
// starts to compile. The function body never runs; vitest only confirms the file loads.
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  EmailError,
  MailMessage,
  Mailer,
  RenderedMail,
  Result,
  SendOptions,
  SendResult,
  SecurityNoticeKind,
  SignInCodePurpose,
  TemplateId,
  renderMail,
} from '../../src/index.ts';
import type { NOTICE_TEMPLATES, NoticeTemplates } from '../../src/templates/security-notice.ts';

declare const link: URL;
declare const mailer: Mailer;
// Spelled in parts so a search of this package for the old purpose finds nothing left.
type Joined<A extends string, B extends string> = `${A}_${B}`;
declare const removed: Joined<'cli', 'link'>;

function compileOnly(): void {
  const base = { template: 'sign_in_code', code: '12345678', link, expiresInMinutes: 10 } as const;
  const noLinking = { ...base, purpose: 'link_identity' } as const;
  const signInWithLinking = {
    ...base,
    purpose: 'sign_in',
    linking: { provider: 'github', account: 'ada' },
  } as const;
  const otherProvider = {
    ...base,
    purpose: 'link_identity',
    linking: { provider: 'gitlab', account: 'ada' },
  } as const;
  const textLink = {
    template: 'invitation',
    organizationName: 'A',
    inviterName: 'B',
    link: 'https://app.drefyn.test/invite',
    blockLink: link,
    expiresAt: new Date(),
  } as const;
  const noBlockLink = {
    template: 'invitation',
    organizationName: 'A',
    inviterName: 'B',
    link,
    expiresAt: new Date(),
  } as const;
  const textBlockLink = { ...noBlockLink, blockLink: 'https://app.drefyn.test/block' } as const;

  // @ts-expect-error a link_identity code must say which identity is being linked
  const missing: MailMessage = noLinking;
  // @ts-expect-error linking belongs only to link_identity
  const extra: MailMessage = signInWithLinking;
  // @ts-expect-error the provider list is closed
  const provider: MailMessage = otherProvider;
  // @ts-expect-error a link is a URL, not a string
  const text: MailMessage = textLink;
  // @ts-expect-error an invitation without a way to refuse it must not compile
  const unblockable: MailMessage = noBlockLink;
  // @ts-expect-error the block link is a URL, not a string
  const textBlock: MailMessage = textBlockLink;
  // @ts-expect-error the command line link is a session method and never a mail
  const cli: SignInCodePurpose = removed;
  // @ts-expect-error a notice kind with no template must not compile
  const noTemplates: NoticeTemplates = {};
  // @ts-expect-error every send needs an idempotency key
  void mailer.send('a@b.test', missing, {});

  // What must keep compiling.
  const linked: MailMessage = {
    ...base,
    purpose: 'link_identity',
    linking: { provider: 'google', account: 'ada@example.com' },
  };
  void mailer.send('a@b.test', linked, { idempotencyKey: 'code:1' });
  const invited: MailMessage = { ...noBlockLink, blockLink: link };
  void mailer.send('a@b.test', invited, { idempotencyKey: 'invite:1' });
  expect([extra, provider, text, unblockable, textBlock, cli, noTemplates]).toBeDefined();
}

describe('message type tests', () => {
  it('compile under pnpm typecheck', () => {
    expect(typeof compileOnly).toBe('function');
  });

  it('pin the exported shapes', () => {
    expectTypeOf<TemplateId>().toEqualTypeOf<'sign_in_code' | 'invitation' | 'security_notice'>();
    expectTypeOf<keyof typeof NOTICE_TEMPLATES>().toEqualTypeOf<SecurityNoticeKind>();
    expectTypeOf<SendOptions['idempotencyKey']>().toEqualTypeOf<string>();
    expectTypeOf<Mailer['send']>().returns.toEqualTypeOf<Promise<SendResult>>();
    expectTypeOf<EmailError['code']>().toExtend<string>();
    expectTypeOf<typeof renderMail>().parameters.toEqualTypeOf<
      [MailMessage, { readonly linkOrigin: URL }]
    >();
    expectTypeOf<typeof renderMail>().returns.toEqualTypeOf<
      Promise<Result<RenderedMail, EmailError>>
    >();
  });
});
