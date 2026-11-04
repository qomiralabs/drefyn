import type { Mailer, MailMessage, SendResult } from '@drefyn/email';
import { idOf } from '@drefyn/tenancy';
import { describe, expect, it, vi } from 'vitest';
import { createAuthMailer } from '../src/server/auth-mail.ts';

const sent: SendResult = { ok: true, value: { messageId: 'm', attempts: 1 } };

function mailer(result: SendResult = sent) {
  const send = vi.fn<Mailer['send']>(() => Promise.resolve(result));
  const adapter = createAuthMailer(
    { configured: true, send, drain: () => Promise.resolve({ dropped: 0 }) },
    () => Promise.resolve('Acme'),
  );
  return { send, adapter };
}

const firstMessage = (send: ReturnType<typeof vi.fn<Mailer['send']>>): MailMessage => {
  const call = send.mock.calls[0];
  if (call === undefined) throw new Error('nothing sent');
  return call[1];
};

describe('the auth mail adapter', () => {
  it('sends a sign in code with its link', async () => {
    const { send, adapter } = mailer();
    const link = new URL('https://app.drefyn.test/sign-in/verify#x.12345678');
    await adapter.sendSignInCode('a@example.com', '12345678', link, 'sign_in');
    expect(send.mock.calls[0]?.[0]).toBe('a@example.com');
    expect(firstMessage(send)).toMatchObject({
      template: 'sign_in_code',
      code: '12345678',
      purpose: 'sign_in',
    });
  });

  it('gives every code its own idempotency key, with no secret in it', async () => {
    const { send, adapter } = mailer();
    const link = new URL('https://app.drefyn.test/sign-in/verify#x.12345678');
    await adapter.sendSignInCode('a@example.com', '12345678', link, 'sign_in');
    await adapter.sendSignInCode('a@example.com', '87654321', link, 'sign_in');
    const [first, second] = send.mock.calls.map((c) => c[2].idempotencyKey);
    expect(first).not.toBe(second);
    expect(first).not.toContain('12345678');
    expect(first).not.toContain('a@example.com');
  });

  it('passes the provider and account of a link code', async () => {
    const { send, adapter } = mailer();
    const link = new URL('https://app.drefyn.test/sign-in/verify#x.12345678');
    await adapter.sendSignInCode('a@example.com', '12345678', link, 'link_identity', {
      provider: 'github',
      account: 'octocat',
    });
    expect(firstMessage(send)).toMatchObject({
      linking: { provider: 'github', account: 'octocat' },
    });
  });

  it('refuses a link code that names no account, rather than guessing one', async () => {
    const { send, adapter } = mailer();
    const link = new URL('https://app.drefyn.test/sign-in/verify#x.12345678');
    await expect(
      adapter.sendSignInCode('a@example.com', '12345678', link, 'link_identity'),
    ).rejects.toThrow('email.input_invalid');
    expect(send).not.toHaveBeenCalled();
  });

  it('names the organization on a notice that carries only its id', async () => {
    const { send, adapter } = mailer();
    await adapter.sendSecurityNotice('a@example.com', {
      kind: 'owner_added',
      organizationId: idOf('org', '01890a5d-ac96-774b-bcce-b302099a8070'),
      membershipId: idOf('mem', '01890a5d-ac96-774b-bcce-b302099a8071'),
      memberName: 'Ada',
      at: new Date('2026-11-04T10:00:00Z'),
    });
    expect(firstMessage(send)).toMatchObject({
      notice: { kind: 'owner_added', organizationName: 'Acme', ownerName: 'Ada' },
    });
  });

  it('throws on a failed send, so auth logs the failure it already handles', async () => {
    const { adapter } = mailer({ ok: false, error: { code: 'email.rejected', retryable: false } });
    const link = new URL('https://app.drefyn.test/sign-in/verify#x.12345678');
    await expect(
      adapter.sendSignInCode('a@example.com', '12345678', link, 'sign_in'),
    ).rejects.toThrow('email.rejected');
  });

  it('keys an invitation by organization, invitation and send count', async () => {
    const { send, adapter } = mailer();
    const organizationId = idOf('org', '01890a5d-ac96-774b-bcce-b302099a8070');
    const invitationId = idOf('inv', '01890a5d-ac96-774b-bcce-b302099a8072');
    await adapter.sendInvitation('a@example.com', {
      organizationId,
      invitationId,
      sendCount: 2,
      organizationName: 'Acme',
      inviterName: 'Maya',
      link: new URL('https://app.drefyn.test/invite#t'),
      blockLink: new URL('https://app.drefyn.test/invite/block#b'),
      expiresAt: new Date('2026-11-10T10:00:00Z'),
    });
    expect(send.mock.calls[0]?.[2].idempotencyKey).toBe(
      `invite:${organizationId}:${invitationId}:2`,
    );
    expect(firstMessage(send).template).toBe('invitation');
  });
});
