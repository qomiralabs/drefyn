import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  SIGN_IN_CODE_PURPOSES,
  createMailer,
  renderMail,
  type MailMessage,
  type SignInCodePurpose,
} from '../src/index.ts';
import { renderText } from '../src/text.ts';
import { createTestTransport } from '../src/testing.ts';
import {
  AT,
  ORIGIN,
  invitation,
  link,
  notice,
  path,
  recorder,
  runs,
  signIn,
  smtpConfig,
  validMessage,
} from './support.ts';

const ctx = { linkOrigin: ORIGIN };

async function refused(message: MailMessage, field: string, linkOrigin: URL = ORIGIN) {
  const result = await renderMail(message, { linkOrigin });
  expect(result).toEqual({
    ok: false,
    error: { code: 'email.input_invalid', retryable: false, field },
  });
}

async function rendered(message: MailMessage, linkOrigin: URL = ORIGIN) {
  const result = await renderMail(message, { linkOrigin });
  if (!result.ok)
    throw new Error(`render refused: ${result.error.code} ${result.error.field ?? ''}`);
  return result.value;
}

const codeMessage = (purpose: SignInCodePurpose): MailMessage =>
  purpose === 'link_identity'
    ? {
        template: 'sign_in_code',
        purpose,
        code: '24681357',
        link: link(),
        expiresInMinutes: 15,
        linking: { provider: 'github', account: 'ada-l' },
      }
    : { template: 'sign_in_code', purpose, code: '24681357', link: link(), expiresInMinutes: 15 };

describe('link guard', () => {
  it('refuses a link on another origin', async () => {
    await refused(signIn({ link: new URL('https://evil.test/verify') }), 'link');
    await refused(signIn({ link: new URL('https://app.drefyn.test:8443/verify') }), 'link');
    await refused(signIn({ link: new URL('https://sub.app.drefyn.test/verify') }), 'link');
    await refused(invitation({ link: new URL('https://evil.test/i') }), 'link');
  });

  it('refuses http on an origin that is not loopback', async () => {
    await refused(signIn({ link: new URL('http://app.drefyn.test/verify') }), 'link');
    const plain = new URL('http://app.drefyn.test');
    await refused(signIn({ link: new URL('http://app.drefyn.test/verify') }), 'link', plain);
  });

  it('allows http only when the configured origin is loopback', async () => {
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      const base = new URL(origin);
      const mail = await rendered(signIn({ link: new URL('/verify', base) }), base);
      expect(mail.text).toContain(`${origin}/verify`);
    }
  });

  it('refuses links that carry credentials or another scheme', async () => {
    await refused(signIn({ link: new URL('https://user:pw@app.drefyn.test/verify') }), 'link');
    await refused(signIn({ link: new URL('javascript:alert(1)') }), 'link');
    await refused(signIn({ link: new URL('mailto:x@app.drefyn.test') }), 'link');
  });

  it('refuses a sessions link on another origin and names the field', async () => {
    await refused(
      notice({ kind: 'new_device_sign_in', at: AT, sessionsLink: new URL('https://evil.test/s') }),
      'notice.sessionsLink',
    );
  });

  it('refuses a link that is not a URL object', async () => {
    await refused(
      { ...signIn(), link: 'https://app.drefyn.test/verify' } as unknown as MailMessage,
      'link',
    );
  });
});

const BLOCK_LABEL = 'I did not expect this';

describe('block link guard', () => {
  it('refuses a block link on another origin and names the field', async () => {
    for (const href of [
      'https://evil.test/block',
      'https://app.drefyn.test:8443/block',
      'https://sub.app.drefyn.test/block',
    ]) {
      await refused(invitation({ blockLink: new URL(href) }), 'blockLink');
    }
  });

  it('refuses credentials, http off loopback and other schemes', async () => {
    for (const href of [
      'https://user:pw@app.drefyn.test/block',
      'https://user@app.drefyn.test/block',
      'http://app.drefyn.test/block',
      'javascript:alert(1)',
      'mailto:x@app.drefyn.test',
    ]) {
      await refused(invitation({ blockLink: new URL(href) }), 'blockLink');
    }
  });

  it('allows http only when the configured origin is loopback', async () => {
    const base = new URL('http://localhost:3000');
    const mail = await rendered(
      invitation({ link: new URL('/invite', base), blockLink: new URL('/invite/block', base) }),
      base,
    );
    expect(mail.text).toContain('http://localhost:3000/invite/block');
  });

  it('refuses a missing block link or one that is not a URL object', async () => {
    const without = {
      template: 'invitation',
      organizationName: 'Acme',
      inviterName: 'Ada Lovelace',
      link: link('/invite'),
      expiresAt: AT,
    };
    await refused(without as unknown as MailMessage, 'blockLink');
    await refused(
      { ...invitation(), blockLink: 'https://app.drefyn.test/block' } as unknown as MailMessage,
      'blockLink',
    );
  });

  it('never hands a refused block link to the transport', async () => {
    const transport = createTestTransport();
    const { logger, metrics } = recorder();
    const mailer = createMailer(smtpConfig(), { linkOrigin: ORIGIN, logger, metrics, transport });
    const result = await mailer.send(
      'person@example.com',
      invitation({ blockLink: new URL('https://evil.test/block') }),
      { idempotencyKey: 'invite:block' },
    );
    expect(result).toEqual({
      ok: false,
      error: { code: 'email.input_invalid', retryable: false, field: 'blockLink' },
    });
    expect(transport.sent).toHaveLength(0);
  });

  // Prefixed hosts, so no generated domain can equal the configured one.
  const foreign = fc
    .tuple(fc.domain(), fc.constantFrom('https:', 'http:'), fc.webPath())
    .map(([host, scheme, p]) => new URL(`${scheme}//x-${host}/p${p}`));

  it('refuses every block link on a foreign origin', async () => {
    await fc.assert(
      fc.asyncProperty(foreign, async (blockLink) => {
        await refused(invitation({ blockLink }), 'blockLink');
      }),
      { ...runs, numRuns: 100 },
    );
  });

  it('accepts every block link on the link origin and renders it', async () => {
    await fc.assert(
      fc.asyncProperty(path, async (blockLink) => {
        const mail = await rendered(invitation({ blockLink }));
        expect(mail.text.split('\n')).toContain(blockLink.href);
      }),
      { ...runs, numRuns: 100 },
    );
  });
});

describe('invitation', () => {
  it('renders the block link after the fine print in the text part', async () => {
    const mail = await rendered(invitation());
    expect(mail.text).toBe(
      [
        'You have been invited',
        '',
        'Ada Lovelace invited you to join Acme on Drefyn.',
        '',
        'Accept the invitation:',
        'https://app.drefyn.test/invite',
        '',
        'The invitation expires on 2026-10-30 14:05 UTC.',
        '',
        '----------------------------------------',
        '',
        'If you did not expect this, you can ignore this email.',
        '',
        `${BLOCK_LABEL}:`,
        'https://app.drefyn.test/invite/block',
        '',
      ].join('\n'),
    );
  });

  it('renders the block link after the fine print in the HTML part, with its address', async () => {
    const mail = await rendered(invitation());
    const fineprint = mail.html.indexOf('If you did not expect this, you can ignore this email.');
    const anchor = mail.html.indexOf(`<a href="https://app.drefyn.test/invite/block"`);
    const label = mail.html.indexOf(`>${BLOCK_LABEL}</a>`);
    const raw = mail.html.indexOf('>https://app.drefyn.test/invite/block</p>');
    expect(fineprint).toBeGreaterThan(0);
    expect(anchor).toBeGreaterThan(fineprint);
    expect(label).toBeGreaterThan(anchor);
    expect(raw).toBeGreaterThan(label);
  });

  const longNames = () =>
    invitation({ organizationName: 'A'.repeat(100), inviterName: 'B'.repeat(100) });

  it('keeps the HTML part under the 100 KB size budget', async () => {
    const mail = await rendered(longNames());
    expect(Buffer.byteLength(mail.html, 'utf8')).toBeLessThan(100 * 1024);
  });

  // Shared runners are too noisy to hold the 20 ms target, which is measured on a quiet
  // machine. This ceiling only catches a render that got several times slower.
  const RENDER_CI_CEILING_MS = 60;

  it(`renders in a warmed median under the ${RENDER_CI_CEILING_MS} ms CI ceiling`, async () => {
    const message = longNames();
    for (let i = 0; i < 5; i++) await rendered(message);
    const times: number[] = [];
    for (let i = 0; i < 21; i++) {
      const started = performance.now();
      await rendered(message);
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    const median = times[10] ?? Number.POSITIVE_INFINITY;
    expect(median, `median ${median.toFixed(2)} ms, CI ceiling`).toBeLessThan(RENDER_CI_CEILING_MS);
  });
});

describe('value guards', () => {
  it('refuses a code that is not exactly 8 ASCII digits', async () => {
    for (const code of [
      '1234567',
      '123456789',
      '1234 5678',
      'abcdefgh',
      '١٢٣٤٥٦٧٨',
      '12345678\n',
      '',
    ]) {
      await refused(signIn({ code }), 'code');
    }
  });

  it('refuses a new address that is not normalized', async () => {
    for (const address of ['New@Example.com', 'not an address', 'a@b.c\r\n']) {
      await refused(
        notice({ kind: 'email_changed', at: AT, newAddress: address as never }),
        'notice.newAddress',
      );
    }
  });

  it('refuses bad numbers, dates, purposes and templates', async () => {
    await refused({ ...signIn(), expiresInMinutes: 0 } as MailMessage, 'expiresInMinutes');
    await refused({ ...signIn(), expiresInMinutes: 1.5 } as MailMessage, 'expiresInMinutes');
    await refused({ ...invitation(), expiresAt: new Date(Number.NaN) } as MailMessage, 'expiresAt');
    await refused(notice({ kind: 'password_set', at: new Date(Number.NaN) }), 'notice.at');
    await refused({ ...signIn(), purpose: 'other' } as unknown as MailMessage, 'purpose');
    await refused({ template: 'newsletter' } as unknown as MailMessage, 'template');
    await refused(null as unknown as MailMessage, 'template');
    await refused(notice({ kind: 'nope' } as never), 'notice.kind');
  });

  it('refuses a link_identity code without linking, and linking on any other purpose', async () => {
    await refused(
      { ...codeMessage('link_identity'), linking: undefined } as unknown as MailMessage,
      'linking',
    );
    await refused(
      { ...signIn(), linking: { provider: 'github', account: 'x' } } as unknown as MailMessage,
      'linking',
    );
  });

  it('refuses empty names', async () => {
    await refused(invitation({ organizationName: '' }), 'organizationName');
    await refused(invitation({ inviterName: '   ' }), 'inviterName');
  });

  it('refuses bidi override characters that would reorder a name', async () => {
    await refused(invitation({ organizationName: 'Acme\u202eevil' }), 'organizationName');
  });

  it('refuses a recipient, sender or reply to that fails the address rule', async () => {
    const transport = createTestTransport();
    const { logger, metrics } = recorder();
    const mailer = createMailer(smtpConfig(), { linkOrigin: ORIGIN, logger, metrics, transport });
    for (const to of [
      'Person@Example.com',
      'person@example.com\r\nBcc: x@evil.test',
      'nobody',
      ' person@example.com',
    ]) {
      const result = await mailer.send(to, signIn(), { idempotencyKey: 'code:1' });
      expect(result).toEqual({
        ok: false,
        error: { code: 'email.input_invalid', retryable: false, field: 'to' },
      });
    }
    for (const idempotencyKey of ['', 'has space', 'x'.repeat(201), 'tab\tkey', 'ключ']) {
      const result = await mailer.send('person@example.com', signIn(), { idempotencyKey });
      expect(result.ok ? null : result.error.field).toBe('idempotencyKey');
    }
    expect(transport.sent).toHaveLength(0);
  });
});

describe('text part', () => {
  it('renders a sign in code exactly, with the code on its own line', async () => {
    const mail = await rendered(signIn());
    expect(mail.text).toBe(
      [
        'Your sign in code',
        '',
        'Enter this code to finish signing in to Drefyn.',
        '',
        '12345678',
        '',
        'The code expires in 10 minutes.',
        '',
        'Open Drefyn:',
        'https://app.drefyn.test/verify',
        '',
        '----------------------------------------',
        '',
        'If you did not ask for this code, you can ignore this email.',
        '',
      ].join('\n'),
    );
  });

  it('renders facts and the rule from the block model', () => {
    const text = renderText({
      subject: 's',
      preheader: 'p',
      blocks: [
        { type: 'heading', text: 'Heading' },
        {
          type: 'facts',
          rows: [
            { label: 'Time', value: '2026-10-30 14:05 UTC' },
            { label: 'Device', value: 'Firefox on macOS' },
          ],
        },
        { type: 'rule' },
        { type: 'fineprint', text: 'Small' },
      ],
    });
    expect(text).toBe(
      'Heading\n\nTime: 2026-10-30 14:05 UTC\nDevice: Firefox on macOS\n\n----------------------------------------\n\nSmall\n',
    );
  });

  it('gives each purpose its own subject and wording, and never puts the code in the subject or preheader', async () => {
    const subjects = new Set<string>();
    const texts = new Set<string>();
    for (const purpose of SIGN_IN_CODE_PURPOSES) {
      const mail = await rendered(codeMessage(purpose));
      expect(mail.purpose).toBe(purpose);
      expect(mail.subject).not.toContain('24681357');
      expect(mail.preheader).not.toContain('24681357');
      expect(mail.text.split('\n')).toContain('24681357');
      subjects.add(mail.subject);
      texts.add(mail.text);
    }
    expect(subjects.size).toBe(SIGN_IN_CODE_PURPOSES.length);
    expect(texts.size).toBe(SIGN_IN_CODE_PURPOSES.length);
  });

  it('names the provider and the account for link codes', async () => {
    const mail = await rendered(codeMessage('link_identity'));
    expect(mail.text).toContain('GitHub');
    expect(mail.text).toContain('ada-l');
    expect(mail.html).toContain('ada-l');
  });

  it('shows times in UTC with the zone named, and the new address masked', async () => {
    const mail = await rendered(
      notice({ kind: 'email_changed', at: AT, newAddress: 'new.person@example.com' as never }),
    );
    expect(mail.noticeKind).toBe('email_changed');
    expect(mail.text).toContain('2026-10-30 14:05 UTC');
    expect(mail.text).toContain('n***@example.com');
    expect(mail.text).not.toContain('new.person@');
  });
});

describe('long names', () => {
  const cut = (text: string, needle: string) =>
    text.split('\n').find((line) => line.includes(needle)) ?? '';

  it.each([
    ['organizationName', 100],
    ['inviterName', 100],
  ] as const)('cuts %s to %i code points with an ellipsis', async (field, limit) => {
    const long = 'Q'.repeat(limit + 50);
    const mail = await rendered(invitation({ [field]: long }));
    const line = cut(mail.text, 'QQQ');
    const name = /Q+…/u.exec(line)?.[0] ?? '';
    expect(Array.from(name)).toHaveLength(limit);
    expect(name.endsWith('…')).toBe(true);
  });

  it('leaves a name at the limit untouched', async () => {
    const exact = 'Q'.repeat(100);
    const mail = await rendered(invitation({ organizationName: exact }));
    expect(mail.text).toContain(exact);
    expect(mail.text).not.toContain('…');
  });

  it('cuts the device at 120 and the account at 254', async () => {
    const device = await rendered(
      notice({ kind: 'new_device_sign_in', at: AT, device: 'D'.repeat(500) }),
    );
    expect(Array.from(/D+…/u.exec(device.text)?.[0] ?? '')).toHaveLength(120);
    const account = await rendered(
      notice({ kind: 'identity_linked', at: AT, provider: 'github', account: 'A'.repeat(500) }),
    );
    expect(Array.from(/A+…/u.exec(account.text)?.[0] ?? '')).toHaveLength(254);
  });

  it('never cuts inside a grapheme', async () => {
    const family = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}';
    const name = 'a'.repeat(97) + family + 'tail';
    const mail = await rendered(invitation({ organizationName: name }));
    // 97 letters and the 5 code point family do not fit with the ellipsis, so the
    // family goes whole.
    expect(mail.text).toContain(`${'a'.repeat(97)}…`);
    expect(mail.text).not.toContain('\u{1F468}');
    const accent = 'e\u0301';
    const accented = await rendered(invitation({ organizationName: accent.repeat(60) }));
    const line = cut(accented.text, 'e\u0301');
    expect(line).toContain(`${accent.repeat(49)}…`);
    expect(line).not.toContain(`${accent.repeat(49)}e…`);
  });
});

describe('HTML part', () => {
  it('escapes names and writes a full document', async () => {
    const mail = await rendered(
      invitation({ organizationName: '<script>alert(1)</script>', inviterName: '"><img src=x>' }),
    );
    expect(mail.html).not.toContain('<script');
    expect(mail.html).not.toContain('<img');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html.startsWith('<!DOCTYPE html')).toBe(true);
    expect(mail.html).toContain('Accept the invitation');
    expect(mail.html).toContain('https://app.drefyn.test/invite');
  });

  it('is byte identical for the same message', async () => {
    const a = await rendered(signIn());
    const b = await rendered(signIn());
    expect(a).toEqual(b);
  });
});

describe('renderMail never throws', () => {
  it('turns a message that throws when read into render_failed', async () => {
    const trap = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
        has() {
          throw new Error('boom');
        },
        ownKeys() {
          throw new Error('boom');
        },
        getOwnPropertyDescriptor() {
          throw new Error('boom');
        },
      },
    ) as MailMessage;
    const result = await renderMail(trap, ctx);
    expect(result).toEqual({ ok: false, error: { code: 'email.render_failed', retryable: false } });
  });

  it('renders every valid message, with the code on its own line in the text part', async () => {
    await fc.assert(
      fc.asyncProperty(validMessage, async (message) => {
        const result = await renderMail(message, ctx);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.template).toBe(message.template);
        expect(result.value.html.length).toBeGreaterThan(0);
        expect(result.value.text.endsWith('\n')).toBe(true);
        if (message.template === 'sign_in_code') {
          expect(result.value.text.split('\n')).toContain(message.code);
          expect(result.value.subject).not.toContain(message.code);
          expect(result.value.preheader).not.toContain(message.code);
        }
      }),
      { ...runs, numRuns: 60 },
    );
  });
});

describe('links are copied before they are checked', () => {
  class LyingUrl extends URL {
    constructor(href: string) {
      super(href);
      Object.defineProperty(this, 'origin', { value: ORIGIN.origin });
    }
  }

  it('refuses a URL subclass that lies about its origin', async () => {
    await refused(signIn({ link: new LyingUrl('https://evil.test/verify') }), 'link');
    await refused(invitation({ link: new LyingUrl('https://evil.test/i') }), 'link');
    await refused(
      notice({
        kind: 'password_changed',
        at: AT,
        sessionsLink: new LyingUrl('https://evil.test/s'),
      }),
      'notice.sessionsLink',
    );
  });

  it('renders the checked link even if the caller edits its URL afterwards', async () => {
    const original = link('/verify');
    const sessions = link('/settings/sessions');
    const pending = [
      renderMail(signIn({ link: original }), ctx),
      renderMail(notice({ kind: 'password_changed', at: AT, sessionsLink: sessions }), ctx),
    ];
    original.href = 'https://evil.test/verify';
    sessions.href = 'https://evil.test/sessions';
    for (const result of await Promise.all(pending)) {
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.html).not.toContain('evil.test');
      expect(result.value.text).not.toContain('evil.test');
      expect(result.value.text).toContain('https://app.drefyn.test/');
    }
  });

  it('delivers the checked link when the URL changes after send', async () => {
    const transport = createTestTransport();
    const { logger, metrics } = recorder();
    const mailer = createMailer(smtpConfig(), { linkOrigin: ORIGIN, logger, metrics, transport });
    const target = link('/verify');
    const sending = mailer.send('person@example.com', signIn({ link: target }), {
      idempotencyKey: 'code:copy',
    });
    target.href = 'https://evil.test/verify';
    expect((await sending).ok).toBe(true);
    const captured = transport.sent[0];
    expect(captured?.links.map(String)).toEqual(['https://app.drefyn.test/verify']);
    expect(captured?.html).not.toContain('evil.test');
  });
});

describe('small wording rules', () => {
  it('refuses direction marks as well as overrides', async () => {
    for (const mark of ['\u200e', '\u200f', '\u061c']) {
      await refused(invitation({ organizationName: `Acme${mark}evil` }), 'organizationName');
    }
  });

  it('says 1 minute, not 1 minutes', async () => {
    const one = await rendered({ ...signIn(), expiresInMinutes: 1 } as MailMessage);
    expect(one.text).toContain('The code expires in 1 minute.');
    const two = await rendered({ ...signIn(), expiresInMinutes: 2 } as MailMessage);
    expect(two.text).toContain('The code expires in 2 minutes.');
  });
});
