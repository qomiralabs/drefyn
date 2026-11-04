import type { MailContent } from '../blocks.ts';
import type { InvitationMail } from '../types.ts';
import { utc } from './words.ts';

// The names sit in evidence rows, never in the heading, so an organization named like an
// instruction reads as a value and not as our own words. The block link closes the footer:
// small enough that accepting stays the one main action, with its address shown like any
// other link so nobody has to trust it unseen.
export function invitationContent(message: InvitationMail, sender: string): MailContent {
  return {
    subject: 'You have been invited to Drefyn',
    preheader: 'Accept the invitation to start working together in Drefyn.',
    folio: 'Invitation',
    sender,
    blocks: [
      { type: 'heading', text: 'You have been invited' },
      {
        type: 'paragraph',
        text: 'Someone invited you to work with them on Drefyn. Accepting adds you to this organization.',
      },
      {
        type: 'facts',
        rows: [
          { label: 'Organization', value: message.organizationName },
          { label: 'Invited by', value: message.inviterName },
          { label: 'Expires', value: utc(message.expiresAt) },
        ],
      },
      { type: 'action', label: 'Accept the invitation', href: message.link },
      { type: 'rule' },
      {
        type: 'fineprint',
        text: 'If you did not expect this, you can ignore this mail, or use the link below so this organization cannot invite this address again.',
      },
      { type: 'action', label: 'I did not expect this', href: message.blockLink, quiet: true },
    ],
  };
}
