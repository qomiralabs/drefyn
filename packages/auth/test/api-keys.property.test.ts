import fc from 'fast-check';
import { idOf } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import { bearer, keyFor, keyRow, verifierFor, verifyResponder } from './api-key-fixtures.ts';
import { mutationsOf, runs } from './support.ts';

const projectIds = fc.uniqueArray(
  fc.uuid({ version: 7 }).map((u) => idOf('prj', u)),
  { maxLength: 8 },
);

describe('verifyApiKey project reach', () => {
  it("answers 'all' only when the column says all, and otherwise exactly the listed rows", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('all', 'listed'), projectIds, async (scope, rows) => {
        const { verifier } = verifierFor(verifyResponder([keyRow({ projectScope: scope })], rows));
        const result = await verifier.verifyApiKey(bearer(), '203.0.113.7');
        if (!result.ok) throw result.error;
        expect(result.value.projectIds).toEqual(scope === 'all' ? 'all' : rows);
      }),
      runs,
    );
  });

  it('refuses every one character edit of a valid key, with one statement at most and no write', async () => {
    const valid = keyFor();
    await fc.assert(
      fc.asyncProperty(mutationsOf(valid), async (mutation) => {
        const { verifier, scripted } = verifierFor(verifyResponder([keyRow()]));
        const result = await verifier.verifyApiKey(`Bearer ${mutation.value}`, '203.0.113.7');
        expect(result.ok).toBe(false);
        expect(scripted.statements().length).toBeLessThanOrEqual(1);
        expect(scripted.writes()).toEqual([]);
      }),
      runs,
    );
  });
});
