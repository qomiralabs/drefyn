import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { renderMail, type MailMessage } from '../../src/index.ts';
import { FIXED_FIELDS, userText } from '../fixtures/user-text.ts';
import { PREVIEW_MESSAGES } from '../fixtures/messages.ts';
import { ORIGIN, runs, validMessage } from '../support.ts';

const ctx = { linkOrigin: ORIGIN };

async function rendered(message: MailMessage) {
  const result = await renderMail(message, ctx);
  if (!result.ok) throw new Error(`render refused: ${result.error.code}`);
  return result.value;
}

describe('subjects and preheaders', () => {
  it('hold no user text and no code in any fixture', async () => {
    for (const [name, message] of PREVIEW_MESSAGES) {
      const mail = await rendered(message);
      for (const value of userText(message)) {
        expect(mail.subject, name).not.toContain(value);
        expect(mail.preheader, name).not.toContain(value);
      }
    }
  });

  it('are fixed per template, purpose and kind', async () => {
    const known = new Set<string>();
    for (const [, message] of PREVIEW_MESSAGES) known.add((await rendered(message)).subject);
    await fc.assert(
      fc.asyncProperty(validMessage, async (message) => {
        const mail = await rendered(message);
        expect(known.has(mail.subject)).toBe(true);
        expect(mail.preheader).toMatch(/^[A-Za-z0-9 .,]+$/);
      }),
      { ...runs, numRuns: 60 },
    );
  });

  it('skips only the fields that are not user text', () => {
    expect(FIXED_FIELDS).toEqual(['template', 'purpose', 'kind', 'provider']);
  });
});
