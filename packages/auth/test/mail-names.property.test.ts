import { normalizeEmailAddress } from '@drefyn/address';
import { renderMail, type MailMessage } from '@drefyn/email';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseOrganizationName } from '../src/index.ts';
import { memberName } from '../src/notices.ts';
import { runs } from './support.ts';

const LINK_ORIGIN = new URL('https://app.drefyn.test');
const AT = new Date('2026-11-04T10:00:00.000Z');

// Grapheme strings reach well past ASCII, and the near links are what the two rules could
// disagree on.
const candidate = fc.oneof(
  fc.string({ unit: 'grapheme', maxLength: 110 }),
  fc.constantFrom('Acme Inc.', 'Version 2.0', 'Node.js', 'A. Smith', 'x.y', 'a. b', 'ﬁ.example'),
  fc.tuple(fc.string({ maxLength: 20 }), fc.string({ maxLength: 20 })).map(([a, b]) => `${a}.${b}`),
);

describe('the mail guard and the auth name rule', () => {
  it('accepts every name auth accepts', async () => {
    await fc.assert(
      fc.asyncProperty(candidate, async (input) => {
        const parsed = parseOrganizationName(input);
        fc.pre(parsed.ok);
        if (!parsed.ok) return;
        const rendered = await renderMail(
          {
            template: 'security_notice',
            notice: {
              kind: 'api_key_created',
              at: AT,
              organizationName: parsed.value,
              keyName: parsed.value,
              displaySuffix: 'x7qa',
            },
          },
          { linkOrigin: LINK_ORIGIN },
        );
        expect(rendered.ok, input).toBe(true);
      }),
      { ...runs, numRuns: 100 },
    );
  });

  it('accepts the owner_added and member_removed notices for any name and any address', async () => {
    const hostileName = fc.oneof(
      candidate,
      fc.string({ unit: 'binary', maxLength: 120 }),
      fc.constantFrom('   ', 'Ada\u202eLovelace', 'Ada\nLovelace', 'http://evil.example/login'),
    );
    const address = fc
      .oneof(
        fc.emailAddress(),
        fc.constantFrom(
          'www.evil.example/login?a=@attacker.example',
          'a%2f@attacker.example',
          'first.last@example.com',
        ),
      )
      .map(normalizeEmailAddress)
      .filter((result) => result.ok)
      .map((result) => result.value);
    const accepted = async (message: MailMessage, label: string) => {
      const rendered = await renderMail(message, { linkOrigin: LINK_ORIGIN });
      expect(rendered.ok, label).toBe(true);
    };
    await fc.assert(
      fc.asyncProperty(fc.option(hostileName), address, async (displayName, email) => {
        const name = memberName(displayName, email);
        const label = JSON.stringify([displayName, email]);
        await accepted(
          {
            template: 'security_notice',
            notice: { kind: 'owner_added', at: AT, organizationName: 'Acme', ownerName: name },
          },
          label,
        );
        await accepted(
          {
            template: 'security_notice',
            notice: {
              kind: 'member_removed',
              at: AT,
              organizationName: 'Acme',
              memberName: name,
              revokedKeys: 0,
            },
          },
          label,
        );
      }),
      { ...runs, numRuns: 100 },
    );
  });
});
