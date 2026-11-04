import { describe, expect, it } from 'vitest';
import { SECURITY_NOTICE_KINDS, renderMail, type MailMessage } from '../../src/index.ts';
import { FIXTURE_MESSAGES } from '../fixtures/messages.ts';
import { AT, ORIGIN, invitation, link, notice } from '../support.ts';

async function rendered(message: MailMessage) {
  const result = await renderMail(message, { linkOrigin: ORIGIN });
  if (!result.ok) throw new Error(`render refused: ${result.error.code}`);
  return result.value;
}

const WHEN = '30 October 2026 at 14:05 UTC';

const fixtures = FIXTURE_MESSAGES.filter(([name]) => name.startsWith('security_notice.'));

describe('every notice kind', () => {
  it('has a fixture for every kind', () => {
    expect(fixtures.map(([name]) => name.replace('security_notice.', ''))).toEqual([
      ...SECURITY_NOTICE_KINDS,
    ]);
  });

  it.each(fixtures)('%s shows the time in UTC and a neutral notice', async (_name, message) => {
    const mail = await rendered(message);
    expect(mail.text.split('\n')[0]).toBe('Drefyn: Security notice');
    expect(mail.text).toMatch(new RegExp(`^When: +${WHEN}$`, 'm'));
    expect(mail.html).toContain(WHEN);
    expect(mail.subject).toContain('Drefyn');
    expect(mail.html).not.toMatch(/#(16A34A|D97706|DC2626)/i);
  });

  it('gives each kind its own subject', async () => {
    const subjects = await Promise.all(fixtures.map(async ([, m]) => (await rendered(m)).subject));
    expect(new Set(subjects).size).toBe(SECURITY_NOTICE_KINDS.length);
  });

  it('shows the method, the device and the sessions link where they are given', async () => {
    const mail = await rendered(
      notice({
        kind: 'new_device_sign_in',
        at: AT,
        method: 'Email code',
        device: 'Firefox on macOS',
        sessionsLink: link('/settings/sessions'),
      }),
    );
    expect(mail.subject).toBe('New sign in to your Drefyn account');
    expect(mail.text).toMatch(/^Method: +Email code$/m);
    expect(mail.text).toMatch(/^Device: +Firefox on macOS$/m);
    expect(mail.text).toContain('Review your sessions:\nhttps://app.drefyn.test/settings/sessions');
    expect(mail.text).toContain('you do not need to do anything');
  });

  it('still says what to do when there is no sessions link', async () => {
    const mail = await rendered(notice({ kind: 'password_changed', at: AT }));
    expect(mail.text).toContain('If this was not you');
    expect(mail.text).not.toContain('Review your sessions:');
  });
});

describe('facts per kind', () => {
  const account = { at: AT, provider: 'github', account: 'ada-l' } as const;

  it.each(['identity_linked', 'identity_unlinked'] as const)('%s', async (kind) => {
    const mail = await rendered(notice({ ...account, kind }));
    expect(mail.text).toMatch(/^Provider: +GitHub$/m);
    expect(mail.text).toMatch(/^Account: +ada-l$/m);
  });

  it('email_changed masks the new address', async () => {
    const mail = await rendered(
      notice({ kind: 'email_changed', at: AT, newAddress: 'new.person@example.com' as never }),
    );
    expect(mail.text).toMatch(/^New address: +n\*\*\*@example\.com$/m);
    expect(mail.html).not.toContain('new.person');
  });

  it('api_key_created names the organization, the key and how it ends', async () => {
    const mail = await rendered(
      notice({
        kind: 'api_key_created',
        at: AT,
        organizationName: 'Acme',
        keyName: 'deploy',
        displaySuffix: 'x7Qa',
      }),
    );
    expect(mail.text).toMatch(/^Organization: +Acme$/m);
    expect(mail.text).toMatch(/^API key: +deploy$/m);
    expect(mail.text).toMatch(/^Ends in: +x7Qa$/m);
  });

  it('owner_added names the organization and the owner', async () => {
    const mail = await rendered(
      notice({ kind: 'owner_added', at: AT, organizationName: 'Acme', ownerName: 'Ada' }),
    );
    expect(mail.text).toMatch(/^Organization: +Acme$/m);
    expect(mail.text).toMatch(/^New owner: +Ada$/m);
    expect(mail.text).toContain('You get this because you are an owner');
  });

  it('member_removed counts revoked keys only when there were any', async () => {
    const none = await rendered(
      notice({
        kind: 'member_removed',
        at: AT,
        organizationName: 'Acme',
        memberName: 'Ada',
        revokedKeys: 0,
      }),
    );
    expect(none.text).toMatch(/^Member: +Ada$/m);
    expect(none.text).not.toContain('Keys revoked');
    const some = await rendered(
      notice({
        kind: 'member_removed',
        at: AT,
        organizationName: 'Acme',
        memberName: 'Ada',
        revokedKeys: 2,
      }),
    );
    expect(some.text).toMatch(/^Keys revoked: +2$/m);
  });

  it('member_keys_revoked names the member and the count', async () => {
    const mail = await rendered(
      notice({
        kind: 'member_keys_revoked',
        at: AT,
        organizationName: 'Acme',
        memberName: 'Ada',
        revokedKeys: 1,
      }),
    );
    expect(mail.text).toMatch(/^Keys revoked: +1$/m);
    expect(mail.text).toMatch(/^Member: +Ada$/m);
  });

  it('refuses a revoked key count that is not a whole number', async () => {
    const result = await renderMail(
      notice({
        kind: 'member_removed',
        at: AT,
        organizationName: 'Acme',
        memberName: 'Ada',
        revokedKeys: 1.5,
      }),
      { linkOrigin: ORIGIN },
    );
    expect(result.ok ? null : result.error.field).toBe('notice.revokedKeys');
  });
});

describe('invitation', () => {
  it('shows who invited whom as facts, with the expiry named', async () => {
    const mail = await rendered(invitation());
    expect(mail.subject).toBe('You have been invited to Drefyn');
    expect(mail.text.split('\n')[0]).toBe('Drefyn: Invitation');
    expect(mail.text).toMatch(/^Organization: +Acme$/m);
    expect(mail.text).toMatch(/^Invited by: +Ada Lovelace$/m);
    expect(mail.text).toMatch(/^Expires: +30 October 2026 at 14:05 UTC$/m);
    expect(mail.text).toContain('Accept the invitation:\nhttps://app.drefyn.test/invite');
  });

  it('keeps one main action: the block link is the quiet one, in the footer', async () => {
    const mail = await rendered(invitation());
    const main = mail.html.indexOf('>Accept the invitation</a>');
    const rule = mail.html.indexOf('dr-divider');
    const block = mail.html.indexOf('>I did not expect this</a>');
    expect(main).toBeGreaterThan(0);
    expect(rule).toBeGreaterThan(main);
    expect(block).toBeGreaterThan(rule);
    expect(mail.html).toContain('>https://app.drefyn.test/invite/block</p>');
  });
});
