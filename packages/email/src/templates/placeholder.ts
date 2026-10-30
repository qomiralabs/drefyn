// Plain wording for every message until the designed templates replace it
// (TODO(#154)). Subjects and preheaders are fixed per template and purpose: they show
// in inbox lists and on lock screens, so they never carry a name or the code.
import type { Block, MailContent } from '../blocks.ts';
import type {
  LinkProvider,
  MailMessage,
  SecurityNoticeKind,
  SecurityNoticeMail,
  SignInCodePurpose,
} from '../types.ts';

const PROVIDER: Readonly<Record<LinkProvider, string>> = { github: 'GitHub', google: 'Google' };

const CODE_MAIL: Readonly<
  Record<SignInCodePurpose, { subject: string; preheader: string; heading: string; lead: string }>
> = {
  sign_in: {
    subject: 'Your Drefyn sign in code',
    preheader: 'Use this code to finish signing in to Drefyn.',
    heading: 'Your sign in code',
    lead: 'Enter this code to finish signing in to Drefyn.',
  },
  link_identity: {
    subject: 'Confirm linking a sign in method',
    preheader: 'Use this code to link a sign in method to your Drefyn account.',
    heading: 'Confirm the link',
    lead: 'Enter this code to link',
  },
  step_up: {
    subject: 'Confirm it is you',
    preheader: 'Use this code to confirm a sensitive change in Drefyn.',
    heading: 'Confirm it is you',
    lead: 'Enter this code to confirm the change you started in Drefyn.',
  },
  password_reset: {
    subject: 'Reset your Drefyn password',
    preheader: 'Use this code to choose a new password.',
    heading: 'Reset your password',
    lead: 'Enter this code to choose a new password for Drefyn.',
  },
  cli_link: {
    subject: 'Sign in to the Drefyn CLI',
    preheader: 'Use this code to finish signing in on the command line.',
    heading: 'Sign in to the CLI',
    lead: 'Enter this code in the Drefyn CLI to finish signing in.',
  },
  email_change: {
    subject: 'Confirm your new email address',
    preheader: 'Use this code to confirm the new address for your Drefyn account.',
    heading: 'Confirm your new address',
    lead: 'Enter this code to make this the address for your Drefyn account.',
  },
};

const NOTICE_SUBJECT: Readonly<Record<SecurityNoticeKind, string>> = {
  identity_linked: 'A sign in method was linked to your account',
  identity_unlinked: 'A sign in method was removed from your account',
  email_changed: 'Your account email address changed',
  password_set: 'A password was set on your account',
  password_changed: 'Your password was changed',
  password_removed: 'Your password was removed',
  password_reset: 'Your password was reset',
  new_device_sign_in: 'New sign in to your account',
  api_key_created: 'A new API key was created',
  owner_added: 'A new owner was added',
  member_removed: 'A member was removed',
};

const PREHEADER = {
  invitation: 'Accept the invitation to start working together in Drefyn.',
  notice: 'A security change on your Drefyn account. Check that it was you.',
} as const;

const FINEPRINT_CODE = 'If you did not ask for this code, you can ignore this email.';
const FINEPRINT_NOTICE =
  'If this was not you, sign in and review your sessions, then change your password.';

// Minutes are fine for a timestamp people compare by eye; the zone is always named.
function utc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

// The person who receives this already owns the old address; the new one is only hinted.
function masked(address: string): string {
  const at = address.lastIndexOf('@');
  return `${address.slice(0, 1)}***${address.slice(at)}`;
}

function codeContent(message: Extract<MailMessage, { template: 'sign_in_code' }>): MailContent {
  const words = CODE_MAIL[message.purpose];
  const lead =
    message.purpose === 'link_identity'
      ? `${words.lead} the ${PROVIDER[message.linking.provider]} account ${message.linking.account} to Drefyn.`
      : words.lead;
  return {
    subject: words.subject,
    preheader: words.preheader,
    blocks: [
      { type: 'heading', text: words.heading },
      { type: 'paragraph', text: lead },
      { type: 'code', code: message.code },
      { type: 'paragraph', text: `The code expires in ${message.expiresInMinutes} minutes.` },
      { type: 'action', label: 'Open Drefyn', href: message.link },
      { type: 'rule' },
      { type: 'fineprint', text: FINEPRINT_CODE },
    ],
  };
}

function invitationContent(message: Extract<MailMessage, { template: 'invitation' }>): MailContent {
  return {
    subject: 'You have been invited to Drefyn',
    preheader: PREHEADER.invitation,
    blocks: [
      { type: 'heading', text: 'You have been invited' },
      {
        type: 'paragraph',
        text: `${message.inviterName} invited you to join ${message.organizationName} on Drefyn.`,
      },
      { type: 'action', label: 'Accept the invitation', href: message.link },
      { type: 'paragraph', text: `The invitation expires on ${utc(message.expiresAt)}.` },
      { type: 'rule' },
      { type: 'fineprint', text: 'If you did not expect this, you can ignore this email.' },
    ],
  };
}

function noticeLead(notice: SecurityNoticeMail): string {
  switch (notice.kind) {
    case 'identity_linked':
      return `The ${PROVIDER[notice.provider]} account ${notice.account} can now sign in to your Drefyn account.`;
    case 'identity_unlinked':
      return `The ${PROVIDER[notice.provider]} account ${notice.account} can no longer sign in to your Drefyn account.`;
    case 'email_changed':
      return `Your Drefyn account now uses ${masked(notice.newAddress)}. Mail about the account no longer comes here.`;
    case 'password_set':
      return 'A password was set, so you can now sign in with it.';
    case 'password_changed':
      return 'Your password was changed.';
    case 'password_removed':
      return 'Your password was removed. You sign in with a code or a linked account.';
    case 'password_reset':
      return 'Your password was reset with a code sent to this address.';
    case 'new_device_sign_in':
      return 'Someone signed in to your Drefyn account from a device we have not seen before.';
    case 'api_key_created':
      return `A new API key, ${notice.keyName}, was created in ${notice.organizationName}.`;
    case 'owner_added':
      return `${notice.ownerName} is now an owner of ${notice.organizationName}.`;
    case 'member_removed':
      return `${notice.memberName} was removed from ${notice.organizationName}.`;
  }
}

function noticeContent(notice: SecurityNoticeMail): MailContent {
  const rows = [{ label: 'Time', value: utc(notice.at) }];
  if (notice.method !== undefined) rows.push({ label: 'Method', value: notice.method });
  if (notice.device !== undefined) rows.push({ label: 'Device', value: notice.device });
  const blocks: Block[] = [
    { type: 'heading', text: NOTICE_SUBJECT[notice.kind] },
    { type: 'paragraph', text: noticeLead(notice) },
    { type: 'facts', rows },
  ];
  if (notice.sessionsLink !== undefined) {
    blocks.push({ type: 'action', label: 'Review your sessions', href: notice.sessionsLink });
  }
  blocks.push({ type: 'rule' }, { type: 'fineprint', text: FINEPRINT_NOTICE });
  return { subject: NOTICE_SUBJECT[notice.kind], preheader: PREHEADER.notice, blocks };
}

export function placeholderContent(message: MailMessage): MailContent {
  switch (message.template) {
    case 'sign_in_code':
      return codeContent(message);
    case 'invitation':
      return invitationContent(message);
    case 'security_notice':
      return noticeContent(message.notice);
  }
}
