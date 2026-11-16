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

const CHECK_SSO =
  'If you did not expect this, review single sign on in your organization settings.';

const CHECK_SUPPORT =
  'If this was not you, contact your administrator or Drefyn support straight away.';

const noRows = () => [];

const domainRows = (
  notice: NoticeOf<'sso_domain_claimed' | 'sso_domain_verified' | 'sso_domain_unverified'>,
) => [
  { label: 'Organization', value: notice.organizationName },
  { label: 'Domain', value: notice.domain },
];

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
  api_key_revoked: {
    subject: 'An API key was revoked in your Drefyn organization',
    preheader: OWNER_PREHEADER,
    heading: 'An API key was revoked',
    lead: () => 'This API key was revoked. Anything using it has stopped working.',
    rows: (n) => [
      { label: 'Organization', value: n.organizationName },
      { label: 'API key', value: n.keyName },
      { label: 'Ends in', value: n.displaySuffix },
    ],
    next: 'If you did not expect this, check who manages API keys in your organization settings.',
    fineprint: OWNER_FINEPRINT,
  },
  owner_added: {
    subject: 'A new owner was added to your Drefyn organization',
    preheader: OWNER_PREHEADER,
    heading: 'A new owner was added',
    lead: () => 'This person can now manage everything in the organization.',
    rows: (n) => [
      { label: 'Organization', value: n.organizationName },
      { label: 'New owner', value: n.memberName },
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
  sso_domain_claimed: {
    subject: 'A domain was claimed for single sign on in your Drefyn organization',
    preheader: OWNER_PREHEADER,
    heading: 'A domain was claimed for single sign on',
    lead: () =>
      'Someone in this organization started proving that it controls this domain. Nothing changes until its DNS record is in place and the domain is verified.',
    rows: domainRows,
    next: CHECK_SSO,
    fineprint: OWNER_FINEPRINT,
  },
  sso_domain_verified: {
    subject: 'A domain was verified for single sign on in your Drefyn organization',
    preheader: OWNER_PREHEADER,
    heading: 'A domain was verified for single sign on',
    lead: () =>
      "People with an address at this domain can now be sent to this organization's identity provider to sign in.",
    rows: domainRows,
    next: CHECK_SSO,
    fineprint: OWNER_FINEPRINT,
  },
  sso_domain_unverified: {
    subject: 'A domain lost its single sign on verification in your Drefyn organization',
    preheader: OWNER_PREHEADER,
    heading: 'A domain is no longer verified',
    lead: () =>
      'The DNS record that proved this domain was missing on three daily checks in a row, so the domain is no longer verified. Single sign on stops for addresses at this domain until it is verified again.',
    rows: domainRows,
    next: 'If you still use this domain, publish its DNS record again and verify it in your organization settings.',
    fineprint: OWNER_FINEPRINT,
  },
  second_factor_added: {
    subject: 'Two step sign in was turned on for your Drefyn account',
    preheader: ACCOUNT_PREHEADER,
    heading: 'Two step sign in is on',
    lead: () =>
      'Signing in to your Drefyn account now needs a code from an authenticator app. Your other sessions were signed out. Existing API keys keep working.',
    rows: noRows,
    next: `${CHECK_SUPPORT} Whoever turned it on holds the recovery codes.`,
    fineprint: ACCOUNT_FINEPRINT,
  },
  second_factor_removed: {
    subject: 'Two step sign in was turned off for your Drefyn account',
    preheader: ACCOUNT_PREHEADER,
    heading: 'Two step sign in is off',
    lead: () =>
      'Signing in to your Drefyn account no longer asks for a code from an authenticator app. Your other sessions were signed out.',
    rows: noRows,
    next: `${CHECK_SUPPORT} Then change your password if you use one.`,
    fineprint: ACCOUNT_FINEPRINT,
  },
  recovery_code_used: {
    subject: 'A recovery code was used on your Drefyn account',
    preheader: ACCOUNT_PREHEADER,
    heading: 'A recovery code was used',
    lead: () =>
      'A recovery code was used in place of your authenticator app. Each code works once. If your phone is gone, set up your authenticator app again from your account settings.',
    rows: (n) => [{ label: 'Codes left', value: n.codesLeft === 0 ? 'None' : String(n.codesLeft) }],
    next: CHECK_PASSWORD,
    fineprint: ACCOUNT_FINEPRINT,
  },
  recovery_codes_replaced: {
    subject: 'Your Drefyn recovery codes were replaced',
    preheader: ACCOUNT_PREHEADER,
    heading: 'Your recovery codes were replaced',
    lead: () =>
      'A new set of recovery codes was made for your Drefyn account. Your old recovery codes no longer work.',
    rows: noRows,
    next: CHECK_PASSWORD,
    fineprint: ACCOUNT_FINEPRINT,
  },
  second_factor_failures: {
    subject: 'Wrong two step sign in codes on your Drefyn account',
    preheader: ACCOUNT_PREHEADER,
    heading: 'Wrong codes were tried',
    lead: () =>
      'Someone got past the first step of signing in to your Drefyn account, then entered wrong codes for the second step.',
    rows: noRows,
    next: 'If this was not you, change your password or how you sign in straight away, and review your sessions.',
    fineprint: ACCOUNT_FINEPRINT,
  },
  second_factor_disabled: {
    subject: 'Codes from your authenticator app stopped working for your Drefyn account',
    preheader: ACCOUNT_PREHEADER,
    heading: 'Authenticator codes are blocked',
    lead: () =>
      'Too many wrong codes were tried, so codes from your authenticator app no longer sign in. Only a recovery code can sign in now, and using one turns the app codes back on.',
    rows: noRows,
    next: 'If this was not you, someone knows how to pass the first step. Change your password or how you sign in straight away.',
    fineprint: ACCOUNT_FINEPRINT,
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
