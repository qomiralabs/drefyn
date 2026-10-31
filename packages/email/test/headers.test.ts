import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createMailer,
  isHeaderSafe,
  renderMail,
  type Envelope,
  type MailMessage,
  type MailTransport,
  type RenderedMail,
} from '../src/index.ts';
import {
  AT,
  ORIGIN,
  invitation,
  link,
  notice,
  recorder,
  runs,
  safeName,
  hostileName,
  smtpConfig,
} from './support.ts';

describe('isHeaderSafe', () => {
  it('takes ordinary values', () => {
    expect(isHeaderSafe('Subject', 'Your Drefyn sign in code')).toBe(true);
    expect(isHeaderSafe('From', 'Drefyn Équipe')).toBe(true);
    expect(isHeaderSafe('Subject', '')).toBe(true);
  });

  it('refuses every C0 and C1 control, DEL and the Unicode line separators', () => {
    const controls = [
      ...Array.from({ length: 0x20 }, (_, i) => i),
      ...Array.from({ length: 0x21 }, (_, i) => 0x7f + i),
      0x2028,
      0x2029,
    ];
    for (const c of controls) {
      expect(isHeaderSafe('Subject', `a${String.fromCharCode(c)}b`), c.toString(16)).toBe(false);
    }
  });

  it('refuses a line over 998 bytes once encoded', () => {
    const name = 'Subject';
    // name, colon and space take 9 bytes of the line.
    expect(isHeaderSafe(name, 'a'.repeat(998 - 9))).toBe(true);
    expect(isHeaderSafe(name, 'a'.repeat(998 - 8))).toBe(false);
    // Non ASCII travels as an encoded word, which is longer than its UTF-8 bytes.
    expect(isHeaderSafe(name, 'é'.repeat(300))).toBe(true);
    expect(isHeaderSafe(name, 'é'.repeat(400))).toBe(false);
  });

  it('refuses unsafe header names', () => {
    expect(isHeaderSafe('X Key', 'v')).toBe(false);
    expect(isHeaderSafe('X:Key', 'v')).toBe(false);
    expect(isHeaderSafe('', 'v')).toBe(false);
    expect(isHeaderSafe('X-Kéy', 'v')).toBe(false);
  });

  it('holds for random strings: any control character means refused', () => {
    fc.assert(
      fc.property(hostileName, (value) => {
        expect(isHeaderSafe('Subject', value)).toBe(false);
      }),
      runs,
    );
  });
});

// Every field a person or another system can put text into.
const hostileCases: readonly [string, (name: string) => MailMessage][] = [
  ['organizationName', (n) => invitation({ organizationName: n })],
  ['inviterName', (n) => invitation({ inviterName: n })],
  [
    'linking.account',
    (n) => ({
      template: 'sign_in_code',
      purpose: 'link_identity',
      code: '12345678',
      link: link(),
      expiresInMinutes: 10,
      linking: { provider: 'github', account: n },
    }),
  ],
  ['notice.device', (n) => notice({ kind: 'new_device_sign_in', at: AT, device: n })],
  ['notice.method', (n) => notice({ kind: 'password_changed', at: AT, method: n })],
  [
    'notice.account',
    (n) => notice({ kind: 'identity_linked', at: AT, provider: 'google', account: n }),
  ],
  [
    'notice.organizationName',
    (n) => notice({ kind: 'api_key_created', at: AT, organizationName: n, keyName: 'ci' }),
  ],
  [
    'notice.keyName',
    (n) => notice({ kind: 'api_key_created', at: AT, organizationName: 'Acme', keyName: n }),
  ],
  [
    'notice.ownerName',
    (n) => notice({ kind: 'owner_added', at: AT, organizationName: 'Acme', ownerName: n }),
  ],
  [
    'notice.memberName',
    (n) => notice({ kind: 'member_removed', at: AT, organizationName: 'Acme', memberName: n }),
  ],
];

describe('hostile names', () => {
  it.each(hostileCases)(
    'refuses control characters in %s and names the field',
    async (field, build) => {
      await fc.assert(
        fc.asyncProperty(hostileName, async (name) => {
          const result = await renderMail(build(name), { linkOrigin: ORIGIN });
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error.code).toBe('email.input_invalid');
            expect(result.error.field).toBe(field);
          }
        }),
        { ...runs, numRuns: 40 },
      );
    },
  );

  it('keeps names out of every header and every header value safe', async () => {
    const seen: { envelope: Envelope; mail: RenderedMail }[] = [];
    const spy: MailTransport = {
      kind: 'test',
      deliver: (envelope, mail) => {
        seen.push({ envelope, mail });
        return Promise.resolve({ ok: true, value: { messageId: envelope.messageId } });
      },
      close: () => Promise.resolve(),
    };
    const { logger, metrics } = recorder();
    const mailer = createMailer(
      smtpConfig({ DREFYN_EMAIL_IDEMPOTENCY_HEADER: 'X-Idempotency-Key' }),
      {
        linkOrigin: ORIGIN,
        logger,
        metrics,
        transport: spy,
      },
    );
    const reference = await renderMail(invitation({ organizationName: 'X', inviterName: 'Y' }), {
      linkOrigin: ORIGIN,
    });
    if (!reference.ok) throw new Error('reference render failed');

    await fc.assert(
      fc.asyncProperty(
        fc.oneof(safeName, hostileName),
        fc.oneof(safeName, hostileName),
        async (org, inviter) => {
          seen.length = 0;
          const result = await mailer.send(
            'person@example.com',
            invitation({ organizationName: org, inviterName: inviter }),
            {
              idempotencyKey: 'invite:1:2:1',
            },
          );
          const hostile = !isHeaderSafe('X', org) || !isHeaderSafe('X', inviter);
          if (hostile) {
            expect(result.ok).toBe(false);
            expect(seen).toHaveLength(0);
            return;
          }
          expect(result.ok).toBe(true);
          const first = seen[0];
          if (first === undefined) throw new Error('nothing delivered');
          const { envelope, mail } = first;
          expect(mail.subject).toBe(reference.value.subject);
          expect(mail.preheader).toBe(reference.value.preheader);
          const values: [string, string][] = [
            ['Subject', mail.subject],
            ['From', `${envelope.fromName} <${envelope.from}>`],
            ['To', envelope.to],
            ['Message-ID', envelope.messageId],
            ...envelope.headers,
          ];
          for (const [name, value] of values) {
            expect(isHeaderSafe(name, value), name).toBe(true);
          }
        },
      ),
      { ...runs, numRuns: 80 },
    );
  });
});
