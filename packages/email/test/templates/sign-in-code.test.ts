import { describe, expect, it } from 'vitest';
import { SIGN_IN_CODE_PURPOSES, renderMail, type MailMessage } from '../../src/index.ts';
import { FIXTURE_MESSAGES } from '../fixtures/messages.ts';
import { ORIGIN, link, signIn } from '../support.ts';

async function rendered(message: MailMessage) {
  const result = await renderMail(message, { linkOrigin: ORIGIN });
  if (!result.ok) throw new Error(`render refused: ${result.error.code}`);
  return result.value;
}

const fixture = (purpose: string): MailMessage => {
  const found = FIXTURE_MESSAGES.find(([name]) => name === `sign_in_code.${purpose}`);
  if (found === undefined) throw new Error(purpose);
  return found[1];
};

// What the code cell shows once its markup is gone.
function codeCell(html: string): { readonly markup: string; readonly text: string } {
  const match = /<p class="[^"]*dr-code[^"]*"[^>]*>(.*?)<\/p>/.exec(html);
  if (match?.[0] === undefined || match[1] === undefined) throw new Error('no code cell');
  return { markup: match[0], text: match[1].replace(/<[^>]*>/g, '') };
}

describe('sign in code mail', () => {
  it('writes the sign in mail exactly', async () => {
    const mail = await rendered(signIn());
    expect(mail.subject).toBe('Your Drefyn sign in code');
    expect(mail.text).toBe(
      [
        'Drefyn: Sign in',
        '',
        'Your sign in code',
        '',
        'Enter this code on the sign in page that asked for it.',
        '',
        'Your code:',
        '',
        '12345678',
        '',
        'It expires in 10 minutes and works once.',
        '',
        'Sign in with a link instead:',
        'https://app.drefyn.test/verify',
        'The link works only in the browser where you asked for the code.',
        '',
        'If you did not ask for this code, you can ignore this mail. Nobody can',
        'sign in without it. Drefyn never asks for a code by phone, chat or',
        'reply.',
        '',
        'Sent by Drefyn for app.drefyn.test',
        '',
      ].join('\n'),
    );
  });

  it.each([
    ['sign_in', 'Your Drefyn sign in code', 'SIGN IN', 'Your sign in code'],
    [
      'link_identity',
      'Confirm a new way to sign in to Drefyn',
      'LINK',
      'Link your GitHub account?',
    ],
    ['step_up', 'Your Drefyn confirmation code', 'CONFIRM', 'Confirm it is you'],
    ['password_reset', 'Reset your Drefyn password', 'PASSWORD', 'Reset your password'],
    ['email_change', 'Confirm your new Drefyn email address', 'CONFIRM', 'Confirm your new email'],
  ])('gives %s its own subject, folio and heading', async (purpose, subject, folio, heading) => {
    const mail = await rendered(fixture(purpose));
    expect(mail.subject).toBe(subject);
    expect(mail.text.split('\n')[0]?.toUpperCase()).toContain(folio);
    expect(mail.text).toContain(heading);
  });

  it('covers exactly the five purposes', () => {
    expect(SIGN_IN_CODE_PURPOSES).toHaveLength(5);
    expect(SIGN_IN_CODE_PURPOSES).not.toContain('cli_link');
  });

  it('names the provider and the account on a link code, as facts', async () => {
    const mail = await rendered(fixture('link_identity'));
    expect(mail.text).toMatch(/^Provider: +GitHub$/m);
    expect(mail.text).toMatch(/^Account: +ada-l$/m);
    expect(mail.html).toContain('<th scope="row"');
    expect(mail.html).toContain('ada-l');
  });

  it('sets the code with no space character and selects it whole', async () => {
    for (const purpose of SIGN_IN_CODE_PURPOSES) {
      const mail = await rendered(fixture(purpose));
      const cell = codeCell(mail.html);
      expect(cell.text).toBe('24681357');
      expect(cell.markup).toContain('user-select:all');
      expect(cell.markup).toContain('-webkit-user-select:all');
      expect(cell.markup).toContain('font-variant-numeric:tabular-nums');
    }
  });

  it('puts the code alone on a line in the text part', async () => {
    const mail = await rendered(signIn({ code: '00000001' }));
    expect(mail.text.split('\n')).toContain('00000001');
  });

  it('renders the action as an underlined text link with its address under it', async () => {
    const mail = await rendered(signIn({ link: link('/sign-in/verify') }));
    const anchor = /<a [^>]*href="https:\/\/app\.drefyn\.test\/sign-in\/verify"[^>]*>/.exec(
      mail.html,
    );
    expect(anchor?.[0]).toContain('text-decoration:underline');
    expect(anchor?.[0]).not.toContain('background');
    expect(mail.html).toContain('>https://app.drefyn.test/sign-in/verify</p>');
  });

  it('shows the folio as text with no logo', async () => {
    const mail = await rendered(signIn());
    expect(mail.html).toMatch(/dr-folio[^>]*>Drefyn</);
    expect(mail.html).toMatch(/dr-folio-label[^>]*>Sign in</);
    expect(mail.html).toContain('role="article"');
  });

  it('names the host in the footer, from the link origin', async () => {
    const base = new URL('https://docs.example.org');
    const result = await renderMail(signIn({ link: new URL('/verify', base) }), {
      linkOrigin: base,
    });
    expect(result.ok ? result.value.text : '').toContain('Sent by Drefyn for docs.example.org');
  });
});
