import type { AuthSecurityNotice } from '@drefyn/auth';
import {
  SECURITY_NOTICE_KINDS,
  renderMail,
  type Mailer,
  type MailMessage,
  type SendResult,
} from '@drefyn/email';
import { idOf } from '@drefyn/tenancy';
import { describe, expect, it, vi } from 'vitest';
import { createAuthMailer } from '../src/server/auth-mailer.ts';

const sent: SendResult = { ok: true, value: { messageId: 'm', attempts: 1 } };
const ORG = idOf('org', '01890a5d-ac96-774b-bcce-b302099a8070');
const INV = idOf('inv', '01890a5d-ac96-774b-bcce-b302099a8072');
const MEMBER = idOf('mem', '01890a5d-ac96-774b-bcce-b302099a8071');
const CHALLENGE = '01890a5d-ac96-774b-bcce-b302099a8073';
const LINK = new URL('https://app.drefyn.test/sign-in/verify#x.12345678');
const SESSIONS = new URL('https://app.drefyn.test/account/sessions');
const AT = new Date('2026-11-04T10:00:00Z');

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
const keyOf = (send: ReturnType<typeof vi.fn<Mailer['send']>>, index = 0) =>
  send.mock.calls[index]?.[2].idempotencyKey;

const deviceNotice = (device: string) =>
  ({
    kind: 'new_device_sign_in',
    method: 'cli_link',
    device,
    at: AT,
    sessionsLink: SESSIONS,
  }) as const;

const KEY = idOf('key', MEMBER.slice(0, -2) + '74');
const ORIGIN = new URL('https://app.drefyn.test');
const NEW_ADDRESS = 'new.person@example.com';

type Notice<K> = AuthSecurityNotice extends infer Union
  ? Union extends { readonly kind: infer Kinds }
    ? K extends Kinds
      ? Union
      : never
    : never
  : never;

const keyNotice = { organizationId: ORG, keyId: KEY, keyName: 'Deploy', displaySuffix: 'x7qa' };
const memberNotice = { organizationId: ORG, membershipId: MEMBER, memberName: 'Ada' };

// Keyed by kind, so a kind added to auth fails to compile until it is proved here.
const EVERY_NOTICE: { readonly [K in AuthSecurityNotice['kind']]: Notice<K> } = {
  email_changed: { kind: 'email_changed', newAddress: NEW_ADDRESS, at: AT },
  identity_linked: { kind: 'identity_linked', provider: 'github', account: 'ada-l', at: AT },
  identity_unlinked: { kind: 'identity_unlinked', provider: 'google', account: 'a@b.test', at: AT },
  password_set: { kind: 'password_set', at: AT },
  password_changed: { kind: 'password_changed', at: AT },
  password_reset: { kind: 'password_reset', at: AT },
  password_removed: { kind: 'password_removed', at: AT },
  new_device_sign_in: deviceNotice('Firefox on Linux'),
  api_key_created: { ...keyNotice, kind: 'api_key_created', at: AT },
  api_key_revoked: { ...keyNotice, kind: 'api_key_revoked', at: AT },
  member_removed: { ...memberNotice, kind: 'member_removed', revokedKeys: 0, at: AT },
  member_keys_revoked: { ...memberNotice, kind: 'member_keys_revoked', revokedKeys: 2, at: AT },
  owner_added: { ...memberNotice, kind: 'owner_added', at: AT },
};

// A mailer that answers the way the real one does: anything the guard refuses never sends.
function guarded(name = 'Acme') {
  const send = vi.fn<Mailer['send']>(async (_to, message) => {
    const rendered = await renderMail(message, { linkOrigin: ORIGIN });
    return rendered.ok ? sent : rendered;
  });
  const adapter = createAuthMailer(
    { configured: true, send, drain: () => Promise.resolve({ dropped: 0 }) },
    () => Promise.resolve(name),
  );
  return { send, adapter };
}

describe('every notice auth can send', () => {
  it('covers each kind the mail package knows', () => {
    expect(Object.keys(EVERY_NOTICE).sort()).toEqual([...SECURITY_NOTICE_KINDS].sort());
  });

  it.each(Object.values(EVERY_NOTICE))('passes the real guard: $kind', async (notice) => {
    const { send, adapter } = guarded();
    await adapter.sendSecurityNotice('owner@example.com', notice);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await send.mock.results[0]?.value).toEqual(sent);
  });

  it.each(['evil.example', 'Acme\u202eInc', 'Acme\nInc', 'www.evil.example', ''])(
    'still goes out for the stored organization name %j, with no name of its own',
    async (stored) => {
      const { adapter, send } = guarded(stored);
      await adapter.sendSecurityNotice('owner@example.com', EVERY_NOTICE.api_key_revoked);
      expect(await send.mock.results[0]?.value).toEqual(sent);
      expect(firstMessage(send)).toMatchObject({
        notice: { organizationName: 'Your organization' },
      });
    },
  );

  it('rejects with only the code when the guard refuses', async () => {
    const { adapter } = guarded();
    const notice = { ...EVERY_NOTICE.api_key_revoked, keyName: 'evil.example' };
    await expect(adapter.sendSecurityNotice('owner@example.com', notice)).rejects.toThrow(
      /^email\.input_invalid$/,
    );
  });
});

describe('sign in codes', () => {
  it('sends the code with its link', async () => {
    const { send, adapter } = mailer();
    await adapter.sendSignInCode('a@example.com', '12345678', LINK, 'sign_in', CHALLENGE);
    expect(send.mock.calls[0]?.[0]).toBe('a@example.com');
    expect(firstMessage(send)).toMatchObject({
      template: 'sign_in_code',
      code: '12345678',
      purpose: 'sign_in',
      expiresInMinutes: 10,
    });
  });

  it('keys a code by its challenge, with no secret or address in the key', async () => {
    const { send, adapter } = mailer();
    await adapter.sendSignInCode('a@example.com', '12345678', LINK, 'sign_in', CHALLENGE);
    expect(keyOf(send)).toBe(`code:${CHALLENGE}`);
  });

  it('passes the provider and account of a link code', async () => {
    const { send, adapter } = mailer();
    await adapter.sendSignInCode('a@example.com', '12345678', LINK, 'link_identity', CHALLENGE, {
      provider: 'github',
      account: 'octocat',
    });
    expect(firstMessage(send)).toMatchObject({
      linking: { provider: 'github', account: 'octocat' },
    });
  });

  it('refuses a link code that names no account, rather than guessing one', async () => {
    const { send, adapter } = mailer();
    await expect(
      adapter.sendSignInCode('a@example.com', '12345678', LINK, 'link_identity', CHALLENGE),
    ).rejects.toThrow('email.input_invalid');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('failed sends', () => {
  it('rejects with only the email error code', async () => {
    const { adapter } = mailer({ ok: false, error: { code: 'email.rejected', retryable: false } });
    const failure = await adapter
      .sendSignInCode('a@example.com', '12345678', LINK, 'sign_in', CHALLENGE)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('email.rejected');
  });
});

describe('invitations', () => {
  it('keys by organization, invitation and send count, with the tenant on the send', async () => {
    const { send, adapter } = mailer();
    await adapter.sendInvitation('a@example.com', {
      organizationId: ORG,
      invitationId: INV,
      sendCount: 2,
      organizationName: 'Acme',
      inviterName: 'Maya',
      link: new URL('https://app.drefyn.test/invite#t'),
      blockLink: new URL('https://app.drefyn.test/invite/block#b'),
      expiresAt: AT,
    });
    expect(keyOf(send)).toBe(`invite:${ORG}:${INV}:2`);
    expect(send.mock.calls[0]?.[2].tenant).toEqual({ organizationId: ORG });
    expect(firstMessage(send)).toMatchObject({
      template: 'invitation',
      blockLink: new URL('https://app.drefyn.test/invite/block#b'),
    });
  });
});

describe('security notices', () => {
  const owner = {
    kind: 'owner_added',
    organizationId: ORG,
    membershipId: MEMBER,
    memberName: 'Ada',
    at: AT,
  } as const;
  const SHAPE = /^notice:[^:]+:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{22}$/;

  it('looks up the organization name and maps the owner name', async () => {
    const { send, adapter } = mailer();
    await adapter.sendSecurityNotice('a@example.com', owner);
    expect(firstMessage(send)).toMatchObject({
      notice: { kind: 'owner_added', organizationName: 'Acme', memberName: 'Ada' },
    });
  });

  it('carries the tenant and marks it in the key', async () => {
    const { send, adapter } = mailer();
    await adapter.sendSecurityNotice('a@example.com', owner);
    expect(keyOf(send)).toMatch(SHAPE);
    expect(keyOf(send)).toContain(`notice:${ORG}:`);
    expect(send.mock.calls[0]?.[2].tenant).toEqual({ organizationId: ORG });
  });

  it('marks a notice with no organization as user', async () => {
    const { send, adapter } = mailer();
    await adapter.sendSecurityNotice('a@example.com', { kind: 'password_set', at: AT });
    expect(keyOf(send)).toMatch(SHAPE);
    expect(keyOf(send)).toContain('notice:user:');
    expect(send.mock.calls[0]?.[2].tenant).toBeUndefined();
  });

  it('gives two recipients of one notice different keys', async () => {
    const { send, adapter } = mailer();
    await adapter.sendSecurityNotice('a@example.com', owner);
    await adapter.sendSecurityNotice('b@example.com', owner);
    expect(keyOf(send, 0)).not.toBe(keyOf(send, 1));
  });

  it('keeps the key on a retry of one notice to one person', async () => {
    const { send, adapter } = mailer();
    await adapter.sendSecurityNotice('a@example.com', owner);
    await adapter.sendSecurityNotice('A@example.com', { ...owner });
    expect(keyOf(send, 0)).toBe(keyOf(send, 1));
  });

  it('gives two events different keys', async () => {
    const { send, adapter } = mailer();
    await adapter.sendSecurityNotice('a@example.com', owner);
    await adapter.sendSecurityNotice('a@example.com', {
      ...owner,
      at: new Date('2026-11-04T10:00:01Z'),
    });
    expect(keyOf(send, 0)).not.toBe(keyOf(send, 1));
  });

  it('puts no address in a key', async () => {
    const { send, adapter } = mailer();
    await adapter.sendSecurityNotice('a@example.com', { kind: 'password_set', at: AT });
    expect(keyOf(send)).not.toContain('example');
  });

  it('normalizes the new address of an email change', async () => {
    const { send, adapter } = mailer();
    await adapter.sendSecurityNotice('a@example.com', {
      kind: 'email_changed',
      newAddress: 'New@Example.com',
      at: AT,
    });
    expect(firstMessage(send)).toMatchObject({ notice: { newAddress: 'new@example.com' } });
  });

  it.each([
    ['email', 'Email code'],
    ['password', 'Password'],
    ['github', 'GitHub'],
    ['google', 'Google'],
    ['cli_link', 'One time link'],
  ] as const)('prints the method %s as %s', async (method, words) => {
    const { send, adapter } = mailer();
    await adapter.sendSecurityNotice('a@example.com', {
      ...deviceNotice('Chrome on macOS'),
      method,
    });
    expect(firstMessage(send)).toMatchObject({ notice: { method: words } });
  });

  it('keeps a plain device', async () => {
    const { send, adapter } = mailer();
    await adapter.sendSecurityNotice('a@example.com', deviceNotice('Chrome on macOS'));
    expect(firstMessage(send)).toMatchObject({ notice: { device: 'Chrome on macOS' } });
  });

  it('leaves out a device the mail guard refuses, rather than losing the notice', async () => {
    const { send, adapter } = mailer();
    await adapter.sendSecurityNotice('a@example.com', deviceNotice('Node.js'));
    const message = firstMessage(send);
    expect(message).toMatchObject({ notice: { kind: 'new_device_sign_in' } });
    expect(JSON.stringify(message)).not.toContain('Node.js');
  });
});
