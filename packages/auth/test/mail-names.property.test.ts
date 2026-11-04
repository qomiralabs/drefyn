import { renderMail } from '@drefyn/email';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseOrganizationName } from '../src/index.ts';
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
});
