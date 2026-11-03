import type { AuthNoticeMailer, AuthSecurityNotice } from './email-change.ts';
import type { AuthInvitationMailer, InvitationSend } from './invitations.ts';
import type { AuthMailer, SignInCodePurpose } from './step-up.ts';

// The test transport behind AuthMailer. Real delivery is @drefyn/email's job; this one
// records what auth asked for, and can be slowed or failed to prove the response never
// waits on mail.

export interface SentCode {
  readonly to: string;
  readonly code: string;
  readonly link: URL;
  readonly purpose: SignInCodePurpose;
  readonly linking?: { readonly provider: 'github' | 'google'; readonly account: string };
}

export interface SentNotice {
  readonly to: string;
  readonly notice: AuthSecurityNotice;
}

export interface SentInvitation {
  readonly to: string;
  readonly invitation: InvitationSend;
}

export interface TestAuthMailer {
  readonly mailer: AuthMailer & AuthNoticeMailer & AuthInvitationMailer;
  // Every call, delivered or not.
  readonly calls: readonly SentCode[];
  // Only the calls that were delivered.
  readonly sent: readonly SentCode[];
  // Security notices that were delivered.
  readonly notices: readonly SentNotice[];
  // Invitations that were delivered.
  readonly invitations: readonly SentInvitation[];
  // The next call rejects, as an SMTP failure would.
  failNext(): void;
}

export function createTestAuthMailer(options: { readonly delayMs?: number } = {}): TestAuthMailer {
  const calls: SentCode[] = [];
  const sent: SentCode[] = [];
  const notices: SentNotice[] = [];
  const invitations: SentInvitation[] = [];
  let failures = 0;
  const delayMs = options.delayMs ?? 0;
  const deliver = async () => {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (failures > 0) {
      failures -= 1;
      throw new Error('test transport refused the message');
    }
  };
  const mailer: AuthMailer & AuthNoticeMailer & AuthInvitationMailer = {
    async sendSignInCode(to, code, link, purpose, linking) {
      const mail: SentCode = {
        to,
        code,
        link,
        purpose,
        ...(linking === undefined
          ? {}
          : { linking: { provider: linking.provider, account: linking.account } }),
      };
      calls.push(mail);
      await deliver();
      sent.push(mail);
    },
    async sendSecurityNotice(to, notice) {
      await deliver();
      notices.push({ to, notice: { ...notice } });
    },
    async sendInvitation(to, invitation) {
      await deliver();
      invitations.push({ to, invitation: { ...invitation } });
    },
  };
  return {
    mailer,
    get calls() {
      return [...calls];
    },
    get sent() {
      return [...sent];
    },
    get notices() {
      return [...notices];
    },
    get invitations() {
      return [...invitations];
    },
    failNext() {
      failures += 1;
    },
  };
}
