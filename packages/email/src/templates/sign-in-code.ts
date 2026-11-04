import type { Block, MailContent } from '../blocks.ts';
import type { SignInCodeMail, SignInCodePurpose } from '../types.ts';
import { PROVIDER, minutes } from './words.ts';

interface CodeWords {
  readonly folio: string;
  readonly subject: string;
  // The expiry follows it. No name and never the code.
  readonly preheader: string;
  readonly heading: string;
  readonly lead: string;
  readonly action: string;
  readonly actionNote: string;
  readonly fineprint: string;
}

const CODE_MAIL: Readonly<Record<SignInCodePurpose, CodeWords>> = {
  sign_in: {
    folio: 'Sign in',
    subject: 'Your Drefyn sign in code',
    preheader: 'Enter it on the sign in page.',
    heading: 'Your sign in code',
    lead: 'Enter this code on the sign in page that asked for it.',
    action: 'Sign in with a link instead',
    actionNote: 'The link works only in the browser where you asked for the code.',
    fineprint:
      'If you did not ask for this code, you can ignore this mail. Nobody can sign in without it. Drefyn never asks for a code by phone, chat or reply.',
  },
  link_identity: {
    folio: 'Link a sign in method',
    subject: 'Confirm a new way to sign in to Drefyn',
    preheader: 'Enter the code to link the account.',
    heading: 'Link your {provider} account?',
    lead: 'Someone signed in with a {provider} account that uses this email address. Enter this code to link it to your Drefyn account, so it can sign you in from now on.',
    action: 'Confirm with a link instead',
    actionNote: 'The link works only in the browser where you started.',
    fineprint:
      'If this was not you, do not enter the code. Nothing is linked and your account stays as it is.',
  },
  step_up: {
    folio: 'Confirm it is you',
    subject: 'Your Drefyn confirmation code',
    preheader: 'Enter it to continue.',
    heading: 'Confirm it is you',
    lead: 'You are about to change something that needs a recent sign in, such as creating an API key or changing your password. Enter this code to continue.',
    action: 'Confirm with a link instead',
    actionNote: 'The link works only in the browser where you asked for the code.',
    fineprint:
      'If you did not ask for this, someone may be signed in as you. Do not enter the code, and review your sessions in your account settings.',
  },
  password_reset: {
    folio: 'Password reset',
    subject: 'Reset your Drefyn password',
    preheader: 'Enter the code to choose a new password.',
    heading: 'Reset your password',
    lead: 'Enter this code to choose a new password. Saving it signs you out everywhere else.',
    action: 'Reset with a link instead',
    actionNote: 'The link works only in the browser where you asked for the code.',
    fineprint:
      'If you did not ask to reset your password, ignore this mail. Your password has not changed.',
  },
  email_change: {
    folio: 'Confirm address',
    subject: 'Confirm your new Drefyn email address',
    preheader: 'Enter the code to use this address.',
    heading: 'Confirm your new email address',
    lead: 'Enter this code to make this the address for your Drefyn account. Your old address gets a notice once the change is made.',
    action: 'Confirm with a link instead',
    actionNote: 'The link works only in the browser where you asked for the change.',
    fineprint:
      'If you did not ask for this, ignore this mail. Nothing changes until the code is entered.',
  },
};

export function signInCodeContent(message: SignInCodeMail, sender: string): MailContent {
  const words = CODE_MAIL[message.purpose];
  const named = (text: string) =>
    message.linking === undefined
      ? text
      : text.replaceAll('{provider}', PROVIDER[message.linking.provider]);
  const expiry = minutes(message.expiresInMinutes);
  const blocks: Block[] = [
    { type: 'heading', text: named(words.heading) },
    { type: 'paragraph', text: named(words.lead) },
  ];
  if (message.linking !== undefined) {
    blocks.push({
      type: 'facts',
      rows: [
        { label: 'Provider', value: PROVIDER[message.linking.provider] },
        { label: 'Account', value: message.linking.account },
      ],
    });
  }
  blocks.push(
    { type: 'code', code: message.code, note: `It expires in ${expiry} and works once.` },
    { type: 'action', label: words.action, href: message.link, note: words.actionNote },
    { type: 'rule' },
    { type: 'fineprint', text: words.fineprint },
  );
  return {
    subject: words.subject,
    preheader: `${words.preheader} It expires in ${expiry}.`,
    folio: words.folio,
    sender,
    blocks,
  };
}
