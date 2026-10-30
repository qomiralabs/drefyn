// Checked by `pnpm typecheck`: each @ts-expect-error fails the build if the line below it
// starts to compile. The function body never runs; vitest only confirms the file loads.
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  EmailError,
  MailMessage,
  Mailer,
  SendOptions,
  SendResult,
  TemplateId,
} from '../../src/index.ts';

declare const link: URL;
declare const mailer: Mailer;

function compileOnly(): void {
  // @ts-expect-error a link_identity code must say which identity is being linked
  const missing: MailMessage = {
    template: 'sign_in_code',
    purpose: 'link_identity',
    code: '12345678',
    link,
    expiresInMinutes: 10,
  };
  // @ts-expect-error linking belongs only to link_identity
  const extra: MailMessage = {
    template: 'sign_in_code',
    purpose: 'sign_in',
    code: '12345678',
    link,
    expiresInMinutes: 10,
    linking: { provider: 'github', account: 'ada' },
  };
  // @ts-expect-error the provider list is closed
  const provider: MailMessage = {
    template: 'sign_in_code',
    purpose: 'link_identity',
    code: '12345678',
    link,
    expiresInMinutes: 10,
    linking: { provider: 'gitlab', account: 'ada' },
  };
  // @ts-expect-error every send needs an idempotency key
  void mailer.send('a@b.test', missing, {});
  // @ts-expect-error a link is a URL, not a string
  const text: MailMessage = {
    template: 'invitation',
    organizationName: 'A',
    inviterName: 'B',
    link: 'https://x',
    expiresAt: new Date(),
  };

  // What must keep compiling.
  const linked: MailMessage = {
    template: 'sign_in_code',
    purpose: 'link_identity',
    code: '12345678',
    link,
    expiresInMinutes: 10,
    linking: { provider: 'google', account: 'ada@example.com' },
  };
  void mailer.send('a@b.test', linked, { idempotencyKey: 'code:1' });
  expect([extra, provider, text]).toBeDefined();
}

describe('message type tests', () => {
  it('compile under pnpm typecheck', () => {
    expect(typeof compileOnly).toBe('function');
  });

  it('pin the exported shapes', () => {
    expectTypeOf<TemplateId>().toEqualTypeOf<'sign_in_code' | 'invitation' | 'security_notice'>();
    expectTypeOf<SendOptions['idempotencyKey']>().toEqualTypeOf<string>();
    expectTypeOf<Mailer['send']>().returns.toEqualTypeOf<Promise<SendResult>>();
    expectTypeOf<EmailError['code']>().toExtend<string>();
  });
});
