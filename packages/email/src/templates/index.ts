import type { MailContent } from '../blocks.ts';
import type { MailMessage } from '../types.ts';
import { invitationContent } from './invitation.ts';
import { securityNoticeContent } from './security-notice.ts';
import { signInCodeContent } from './sign-in-code.ts';

// Subjects and preheaders are fixed per template and purpose: they show in inbox lists and
// on lock screens, so they never carry a name or the code. All of this is synchronous on
// purpose, since static rendering does not wait for anything suspended.
export function mailContent(message: MailMessage, ctx: { readonly linkOrigin: URL }): MailContent {
  const sender = `Sent by Drefyn for ${ctx.linkOrigin.host}`;
  switch (message.template) {
    case 'sign_in_code':
      return signInCodeContent(message, sender);
    case 'invitation':
      return invitationContent(message, sender);
    case 'security_notice':
      return securityNoticeContent(message.notice, sender);
  }
}
