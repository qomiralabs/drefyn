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
        return { ...facts, kind, organizationName: ORG, keyName: 'deploy <ci>' };
      case 'owner_added':
        return { ...facts, kind, organizationName: ORG, ownerName: PERSON };
      case 'member_removed':
        return { at: AT, kind, organizationName: ORG, memberName: PERSON };
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
      expiresAt: AT,
    },
  ],
  ...SECURITY_NOTICE_KINDS.map((k) => [`security_notice.${k}`, noticeMail(k)] as const),
];
