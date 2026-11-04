import type { NormalizedEmailAddress } from '@drefyn/address';
import {
  SECURITY_NOTICE_KINDS,
  SIGN_IN_CODE_PURPOSES,
  type MailMessage,
  type NoticeFacts,
  type SecurityNoticeKind,
  type SecurityNoticeMail,
  type SignInCodePurpose,
} from '../../src/index.ts';
import { AT, link } from '../support.ts';

// Names carry markup and quotes so the fixtures pin escaping too, not only layout.
const ORG = 'Acme & Sons <Ltd>';
const PERSON = 'Ada "the Countess" Lovelace';

const facts: NoticeFacts = {
  at: AT,
  method: 'Passkey',
  device: 'Firefox on Linux',
  sessionsLink: link('/settings/sessions'),
};

function codeMail(purpose: SignInCodePurpose): MailMessage {
  const base = { template: 'sign_in_code', code: '24681357', link: link(), expiresInMinutes: 15 };
  return purpose === 'link_identity'
    ? {
        ...base,
        template: 'sign_in_code',
        purpose,
        linking: { provider: 'github', account: 'ada-l' },
      }
    : { ...base, template: 'sign_in_code', purpose };
}

function noticeMail(kind: SecurityNoticeKind): MailMessage {
  const n = ((): SecurityNoticeMail => {
    switch (kind) {
      case 'identity_linked':
        return { ...facts, kind, provider: 'google', account: 'ada@example.com' };
      case 'identity_unlinked':
        return { at: AT, kind, provider: 'github', account: 'ada-l' };
      case 'email_changed':
        return { ...facts, kind, newAddress: 'new.person@example.com' as NormalizedEmailAddress };
      case 'api_key_created':
        return {
          ...facts,
          kind,
          organizationName: ORG,
          keyName: 'deploy <ci>',
          displaySuffix: 'x7Qa',
        };
      case 'owner_added':
        return { ...facts, kind, organizationName: ORG, ownerName: PERSON };
      case 'member_removed':
      case 'member_keys_revoked':
        return { at: AT, kind, organizationName: ORG, memberName: PERSON, revokedKeys: 2 };
      case 'password_set':
        return { at: AT, kind };
      default:
        return { ...facts, kind };
    }
  })();
  return { template: 'security_notice', notice: n };
}

// One entry per message kind: every sign in code purpose, the invitation and every
// security notice. The name is the fixture file stem.
export const FIXTURE_MESSAGES: readonly (readonly [string, MailMessage])[] = [
  ...SIGN_IN_CODE_PURPOSES.map((p) => [`sign_in_code.${p}`, codeMail(p)] as const),
  [
    'invitation',
    {
      template: 'invitation',
      organizationName: ORG,
      inviterName: PERSON,
      link: link('/invite'),
      blockLink: link('/invite/block'),
      expiresAt: AT,
    },
  ],
  ...SECURITY_NOTICE_KINDS.map((k) => [`security_notice.${k}`, noticeMail(k)] as const),
];

const LONG_ORG =
  'The Very Long Named Organization Of Everyone Who Ever Wrote Documentation '.repeat(2);
const LONG_PERSON = 'Augusta Ada King Countess of Lovelace And Then Some More Names '.repeat(3);
const LONG_DEVICE =
  'Microsoft Edge 131 on Windows 11 Enterprise, on a managed work laptop with a very long user agent family label that keeps going';
const LONG_ACCOUNT = `${'very.long.account.name.'.repeat(10)}@example.com`;
const LONG_WORD = 'W'.repeat(100);

// Markup, quotes, a linkable address and a name that tries to read as an instruction, so a
// render shows what a hostile name can and cannot do.
const HOSTILE = '<script>alert(1)</script> & "quotes" \'single\' evil.example/login';
const HOSTILE_ACCOUNT = '<img src=x onerror=alert(1)>@evil.example';

// Everything the preview writes and the budgets measure.
export const PREVIEW_MESSAGES: readonly (readonly [string, MailMessage])[] = [
  ...FIXTURE_MESSAGES,
  [
    'long.invitation',
    {
      template: 'invitation',
      organizationName: LONG_ORG,
      inviterName: LONG_PERSON,
      link: link('/invite'),
      blockLink: link('/invite/block'),
      expiresAt: AT,
    },
  ],
  [
    'long.link_identity',
    {
      template: 'sign_in_code',
      purpose: 'link_identity',
      code: '24681357',
      link: link(),
      expiresInMinutes: 15,
      linking: { provider: 'google', account: LONG_ACCOUNT },
    },
  ],
  [
    'long.new_device_sign_in',
    {
      template: 'security_notice',
      notice: {
        kind: 'new_device_sign_in',
        at: AT,
        method: 'Email code',
        device: LONG_DEVICE,
        sessionsLink: link('/settings/sessions'),
      },
    },
  ],
  [
    'long.identity_linked',
    {
      template: 'security_notice',
      notice: {
        kind: 'identity_linked',
        at: AT,
        provider: 'github',
        account: LONG_ACCOUNT,
        device: LONG_DEVICE,
      },
    },
  ],
  [
    'long.api_key_created',
    {
      template: 'security_notice',
      notice: {
        kind: 'api_key_created',
        at: AT,
        organizationName: LONG_ORG,
        keyName: LONG_WORD,
        displaySuffix: 'x7Qa',
      },
    },
  ],
  [
    'long.member_removed',
    {
      template: 'security_notice',
      notice: {
        kind: 'member_removed',
        at: AT,
        organizationName: LONG_ORG,
        memberName: LONG_PERSON,
        revokedKeys: 1200,
      },
    },
  ],
  [
    'hostile.invitation',
    {
      template: 'invitation',
      organizationName: HOSTILE,
      inviterName: HOSTILE,
      link: link('/invite'),
      blockLink: link('/invite/block'),
      expiresAt: AT,
    },
  ],
  [
    'hostile.link_identity',
    {
      template: 'sign_in_code',
      purpose: 'link_identity',
      code: '24681357',
      link: link(),
      expiresInMinutes: 15,
      linking: { provider: 'github', account: HOSTILE_ACCOUNT },
    },
  ],
  [
    'hostile.new_device_sign_in',
    {
      template: 'security_notice',
      notice: {
        kind: 'new_device_sign_in',
        at: AT,
        method: HOSTILE,
        device: HOSTILE,
        sessionsLink: link('/settings/sessions'),
      },
    },
  ],
  [
    'hostile.api_key_created',
    {
      template: 'security_notice',
      notice: {
        kind: 'api_key_created',
        at: AT,
        organizationName: HOSTILE,
        keyName: HOSTILE,
        displaySuffix: 'x7Qa',
      },
    },
  ],
  [
    'hostile.owner_added',
    {
      template: 'security_notice',
      notice: { kind: 'owner_added', at: AT, organizationName: HOSTILE, ownerName: HOSTILE },
    },
  ],
  [
    'hostile.member_keys_revoked',
    {
      template: 'security_notice',
      notice: {
        kind: 'member_keys_revoked',
        at: AT,
        organizationName: HOSTILE,
        memberName: HOSTILE,
        revokedKeys: 1,
      },
    },
  ],
];
