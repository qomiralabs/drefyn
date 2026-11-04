import { randomUUID } from 'node:crypto';
import { normalizeEmailAddress, type NormalizedEmailAddress } from '@drefyn/address';
import type {
  AuthInvitationMailer,
  AuthMailer,
  AuthNoticeMailer,
  AuthSecurityNotice,
} from '@drefyn/auth';
import type { Mailer, MailMessage, SecurityNoticeMail } from '@drefyn/email';
import type { OrganizationId } from '@drefyn/tenancy';

const CODE_MINUTES = 10;

export type OrganizationName = (organizationId: OrganizationId) => Promise<string>;

function address(value: string): NormalizedEmailAddress {
  const normalized = normalizeEmailAddress(value);
  if (!normalized.ok) throw new Error('email.input_invalid');
  return normalized.value;
}

// Auth treats a rejected send as a failed mail and logs it, so a failure here is thrown.
async function deliver(
  mailer: Mailer,
  to: string,
  message: MailMessage,
  idempotencyKey: string,
): Promise<void> {
  const result = await mailer.send(address(to), message, { idempotencyKey });
  if (!result.ok) throw new Error(result.error.code);
}

// Notices carry ids, since auth never reads a name it does not need; the mail needs the name.
async function noticeMail(
  notice: AuthSecurityNotice,
  organizationName: OrganizationName,
): Promise<SecurityNoticeMail> {
  switch (notice.kind) {
    case 'email_changed':
      return { ...notice, newAddress: address(notice.newAddress) };
    case 'api_key_created':
      return {
        kind: notice.kind,
        at: notice.at,
        organizationName: await organizationName(notice.organizationId),
        keyName: notice.keyName,
        displaySuffix: notice.displaySuffix,
      };
    case 'member_removed':
    case 'member_keys_revoked':
      return {
        kind: notice.kind,
        at: notice.at,
        organizationName: await organizationName(notice.organizationId),
        memberName: notice.memberName,
        revokedKeys: notice.revokedKeys,
      };
    case 'owner_added':
      return {
        kind: notice.kind,
        at: notice.at,
        organizationName: await organizationName(notice.organizationId),
        ownerName: notice.memberName,
      };
    default:
      return notice;
  }
}

export function createAuthMailer(
  mailer: Mailer,
  organizationName: OrganizationName,
): AuthMailer & AuthNoticeMailer & AuthInvitationMailer {
  return {
    async sendSignInCode(to, code, link, purpose, linking) {
      const fields = {
        template: 'sign_in_code',
        code,
        link,
        expiresInMinutes: CODE_MINUTES,
      } as const;
      // Auth always names the account on a link code. A mail that names none would ask the
      // person to approve something they cannot see, so it is refused rather than guessed.
      if (purpose === 'link_identity' && linking === undefined) {
        throw new Error('email.input_invalid');
      }
      const message: MailMessage =
        purpose === 'link_identity' && linking !== undefined
          ? { ...fields, purpose, linking }
          : { ...fields, purpose: purpose as Exclude<typeof purpose, 'link_identity'> };
      // Each code is its own message, and the key carries neither the code nor the address.
      await deliver(mailer, to, message, `code:${randomUUID()}`);
    },
    async sendSecurityNotice(to, notice) {
      const message: MailMessage = {
        template: 'security_notice',
        notice: await noticeMail(notice, organizationName),
      };
      await deliver(mailer, to, message, `notice:${randomUUID()}`);
    },
    async sendInvitation(to, invitation) {
      const { organizationId, invitationId, sendCount } = invitation;
      await deliver(
        mailer,
        to,
        {
          template: 'invitation',
          organizationName: invitation.organizationName,
          inviterName: invitation.inviterName,
          link: invitation.link,
          blockLink: invitation.blockLink,
          expiresAt: invitation.expiresAt,
        },
        `invite:${organizationId}:${invitationId}:${String(sendCount)}`,
      );
    },
  };
}
