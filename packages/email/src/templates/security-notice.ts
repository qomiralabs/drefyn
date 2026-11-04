import type { Block, FactRow, MailContent } from '../blocks.ts';
import type { SecurityNoticeKind, SecurityNoticeMail } from '../types.ts';
import { PROVIDER, utc } from './words.ts';

type NoticeOf<K extends SecurityNoticeKind> = SecurityNoticeMail & { readonly kind: K };

interface NoticeTemplate<K extends SecurityNoticeKind> {
  // Fixed per kind: these show in inbox lists and on lock screens.
  readonly subject: string;
  readonly preheader: string;
  readonly heading: string;
  readonly lead: (notice: NoticeOf<K>) => string;
  // The evidence for this kind, shown above the time.
  readonly rows: (notice: NoticeOf<K>) => readonly FactRow[];
  // What to do if this was not expected.
  readonly next: string;
  readonly fineprint: string;
}

// A mapped type, so a new kind fails to compile until it has a template.
export type NoticeTemplates = { readonly [K in SecurityNoticeKind]: NoticeTemplate<K> };

const ACCOUNT_PREHEADER = 'A security change on your Drefyn account. Check that it was you.';
const OWNER_PREHEADER = 'A change in your Drefyn organization. Check that you expected it.';
const ACCOUNT_FINEPRINT =
  'Security notices go to the address on your account and cannot be turned off.';
const OWNER_FINEPRINT =
  'You get this because you are an owner of this organization. Security notices cannot be turned off.';
const CHECK_PASSWORD =
  'If this was not you, reset your password straight away and review your sessions.';
const CHECK_MEMBERS =
  'If you did not expect this, review the members in your organization settings.';

const noRows = () => [];

const identityRows = (notice: NoticeOf<'identity_linked' | 'identity_unlinked'>) => [
  { label: 'Provider', value: PROVIDER[notice.provider] },
  { label: 'Account', value: notice.account },
];

const memberRows = (notice: NoticeOf<'member_removed' | 'member_keys_revoked'>) => [
  { label: 'Organization', value: notice.organizationName },
  { label: 'Member', value: notice.memberName },
  ...(notice.revokedKeys > 0 ? [{ label: 'Keys revoked', value: String(notice.revokedKeys) }] : []),
];

// The person who receives this already owns the old address; the new one is only hinted.
function masked(address: string): string {
  const at = address.lastIndexOf('@');
  return `${address.slice(0, 1)}***${address.slice(at)}`;
}

export const NOTICE_TEMPLATES: NoticeTemplates = {
  identity_linked: {
    subject: 'A sign in method was linked to your Drefyn account',
    preheader: ACCOUNT_PREHEADER,
    heading: 'A sign in method was linked',
    lead: (n) => `This ${PROVIDER[n.provider]} account can now sign in to your Drefyn account.`,
    rows: identityRows,
    next: 'If this was not you, remove it in your account settings and review your sessions.',
    fineprint: ACCOUNT_FINEPRINT,
  },
  identity_unlinked: {
    subject: 'A sign in method was removed from your Drefyn account',
    preheader: ACCOUNT_PREHEADER,
    heading: 'A sign in method was removed',
    lead: (n) =>
      `This ${PROVIDER[n.provider]} account can no longer sign in to your Drefyn account.`,
    rows: identityRows,
    next: 'If this was not you, review your sessions and change your password if you use one.',
    fineprint: ACCOUNT_FINEPRINT,
  },
  email_changed: {
    subject: 'Your Drefyn email address changed',
    preheader: ACCOUNT_PREHEADER,
    heading: 'Your email address changed',
    lead: () =>
      'Your Drefyn account now uses a new address. Mail about the account no longer comes here.',
    rows: (n) => [{ label: 'New address', value: masked(n.newAddress) }],
    next: 'If this was not you, contact your administrator or Drefyn support straight away. Sign in codes no longer come to this address.',
    fineprint: 'This notice goes to your old address and cannot be turned off.',
  },
  password_set: {
    subject: 'A password was set on your Drefyn account',
    preheader: ACCOUNT_PREHEADER,
    heading: 'A password was set',
    lead: () => 'Your Drefyn account can now sign in with a password.',
    rows: noRows,
    next: CHECK_PASSWORD,
    fineprint: ACCOUNT_FINEPRINT,
  },
  password_changed: {
    subject: 'Your Drefyn password was changed',
    preheader: ACCOUNT_PREHEADER,
    heading: 'Your password was changed',
    lead: () => 'The password on your Drefyn account was changed.',
    rows: noRows,
    next: CHECK_PASSWORD,
    fineprint: ACCOUNT_FINEPRINT,
  },
  password_removed: {
    subject: 'Your Drefyn password was removed',
    preheader: ACCOUNT_PREHEADER,
    heading: 'Your password was removed',
    lead: () => 'You now sign in to Drefyn with a code or a linked account.',
    rows: noRows,
    next: 'If this was not you, review your sessions in your account settings straight away.',
    fineprint: ACCOUNT_FINEPRINT,
  },
  password_reset: {
    subject: 'Your Drefyn password was reset',
    preheader: ACCOUNT_PREHEADER,
    heading: 'Your password was reset',
    lead: () => 'Your password was reset with a code sent to this address.',
    rows: noRows,
    next: CHECK_PASSWORD,
    fineprint: ACCOUNT_FINEPRINT,
  },
  new_device_sign_in: {
    subject: 'New sign in to your Drefyn account',
    preheader:
      'A browser that has not signed in before just did. If it was you, there is nothing to do.',
    heading: 'A new device signed in',
    lead: () =>
      'Someone signed in to your Drefyn account from a browser that has not signed in before. If this was you, you do not need to do anything.',
    rows: noRows,
    next: 'If this was not you, sign out that session now, then change your password if you use one.',
    fineprint: ACCOUNT_FINEPRINT,
  },
  api_key_created: {
    subject: 'A new API key was created in your Drefyn organization',
    preheader: OWNER_PREHEADER,
    heading: 'A new API key was created',
    lead: () => 'A new API key can now reach this organization.',
    rows: (n) => [
      { label: 'Organization', value: n.organizationName },
      { label: 'API key', value: n.keyName },
      { label: 'Ends in', value: n.displaySuffix },
    ],
    next: 'If you do not recognize it, revoke it in your organization settings.',
    fineprint: OWNER_FINEPRINT,
  },
  owner_added: {
    subject: 'A new owner was added to your Drefyn organization',
    preheader: OWNER_PREHEADER,
    heading: 'A new owner was added',
    lead: () => 'This person can now manage everything in the organization.',
    rows: (n) => [
      { label: 'Organization', value: n.organizationName },
      { label: 'New owner', value: n.ownerName },
    ],
    next: CHECK_MEMBERS,
    fineprint: OWNER_FINEPRINT,
  },
  member_removed: {
    subject: 'A member was removed from your Drefyn organization',
    preheader: OWNER_PREHEADER,
    heading: 'A member was removed',
    lead: () => 'This person no longer has access to the organization.',
    rows: memberRows,
    next: CHECK_MEMBERS,
    fineprint: OWNER_FINEPRINT,
  },
  member_keys_revoked: {
    subject: 'API keys were revoked in your Drefyn organization',
    preheader: OWNER_PREHEADER,
    heading: 'API keys were revoked',
    lead: () =>
      'A member changed to a role that cannot hold API keys, so their keys were revoked. Anything using those keys has stopped working.',
    rows: memberRows,
    next: CHECK_MEMBERS,
    fineprint: OWNER_FINEPRINT,
  },
};

export function securityNoticeContent(notice: SecurityNoticeMail, sender: string): MailContent {
  // The kind picks its own template, a link the types cannot follow through the lookup.
  const template = NOTICE_TEMPLATES[notice.kind] as NoticeTemplate<SecurityNoticeKind>;
  const facts: FactRow[] = [...template.rows(notice), { label: 'When', value: utc(notice.at) }];
  if (notice.method !== undefined) facts.push({ label: 'Method', value: notice.method });
  if (notice.device !== undefined) facts.push({ label: 'Device', value: notice.device });
  const blocks: Block[] = [
    { type: 'heading', text: template.heading },
    { type: 'paragraph', text: template.lead(notice) },
    { type: 'facts', rows: facts },
    { type: 'paragraph', text: template.next },
  ];
  if (notice.sessionsLink !== undefined) {
    blocks.push({ type: 'action', label: 'Review your sessions', href: notice.sessionsLink });
  }
  blocks.push({ type: 'rule' }, { type: 'fineprint', text: template.fineprint });
  return {
    subject: template.subject,
    preheader: template.preheader,
    folio: 'Security notice',
    sender,
    blocks,
  };
}
