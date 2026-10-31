import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sessionResponder, sessionRow, setup, tokenFor } from './session-fixtures.ts';
import { lengthChangesOf, mutationsOf, runs } from './support.ts';

const valid = tokenFor();

describe('session tokens under mutation', () => {
  it('resolves the valid token itself', async () => {
    const { sessions } = setup(sessionResponder([sessionRow()]));
    await expect(sessions.resolveSession(valid)).resolves.not.toBeNull();
  });

  // The store holds the one real row, so a mutation that still parses either names another
  // session (no row) or carries another secret (the compare fails).
  it('resolves any single character edit to null, with no write', async () => {
    await fc.assert(
      fc.asyncProperty(mutationsOf(valid), async (mutation) => {
        const { sessions, scripted } = setup(sessionResponder([sessionRow()]));
        expect(await sessions.resolveSession(mutation.value)).toBeNull();
        expect(scripted.writes()).toEqual([]);
        expect(scripted.statements().length).toBeLessThanOrEqual(1);
      }),
      runs,
    );
  });

  it('resolves any length change to null without a transaction', async () => {
    await fc.assert(
      fc.asyncProperty(lengthChangesOf(valid), async (value) => {
        const { sessions, scripted } = setup(sessionResponder([sessionRow()]));
        expect(await sessions.resolveSession(value)).toBeNull();
        expect(scripted.events).toEqual([]);
      }),
      runs,
    );
  });
});
