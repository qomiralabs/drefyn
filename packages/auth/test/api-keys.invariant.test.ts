import { describe, expect, it } from 'vitest';
import {
  KEY,
  ORG,
  OTHER_KEY,
  PROJECT_A,
  PROJECT_B,
  bearer,
  isKeyProjects,
  isKeyProof,
  isUseWrite,
  keyFor,
  keyRow,
  verifierFor,
  verifyResponder,
} from './api-key-fixtures.ts';

// Wrong secret, missing row and expired row: the cases where the key proves nothing.
const FAILURES = [
  {
    name: 'a wrong secret',
    rows: [keyRow({ secret: Buffer.alloc(32, 1) })],
    key: keyFor(),
  },
  { name: 'a missing row', rows: [], key: keyFor() },
  { name: 'a row for another key id', rows: [keyRow()], key: keyFor(ORG, OTHER_KEY) },
  { name: 'an expired row', rows: [keyRow({ live: false })], key: keyFor() },
  { name: 'a revoked row', rows: [keyRow({ live: false })], key: keyFor() },
  {
    name: 'an expired row that is also due a use write',
    rows: [keyRow({ live: false, useDue: true, projectScope: 'listed' })],
    key: keyFor(),
  },
] as const;

describe('verifyApiKey proves the key before anything else runs in its organization', () => {
  for (const failure of FAILURES) {
    it(`sends exactly one statement and no write for ${failure.name}`, async () => {
      const { verifier, scripted, limiter } = verifierFor(
        verifyResponder(failure.rows, [PROJECT_A]),
      );
      const result = await verifier.verifyApiKey(bearer(failure.key), '203.0.113.7');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('AUTH_API_KEY_INVALID');
      const statements = scripted.statements();
      expect(statements).toHaveLength(1);
      expect(statements[0] !== undefined && isKeyProof(statements[0])).toBe(true);
      expect(scripted.writes()).toEqual([]);
      expect(scripted.events.at(-1)).toEqual({ kind: 'rollback' });
      // Counted in the limiter's own transaction, never in the key's organization.
      expect(limiter.keys).toEqual(['ip4:203.0.113.7']);
    });
  }

  it('runs under the organization the key names and selects only the key row by id', async () => {
    const { verifier, scripted } = verifierFor(verifyResponder([keyRow()]));
    await verifier.verifyApiKey(bearer(), '203.0.113.7');
    expect(scripted.events[0]).toEqual({
      kind: 'begin',
      scope: 'organization',
      organizationId: ORG,
    });
    const [first, ...rest] = scripted.statements();
    expect(first?.sql).toMatch(
      /^select .* from "api_keys" where "id" = \$1 and "organization_id" = \$2$/,
    );
    expect(first?.parameters).toEqual([KEY, ORG]);
    expect(first?.sql).toContain('"project_scope"');
    // Revoked is read with expiry, by the same statement, so it costs no extra round trip.
    expect(first?.sql).toContain(
      '(expires_at is null or expires_at > now()) and revoked_at is null',
    );
    expect(rest).toEqual([]);
  });

  it("answers 'all' only from the column, with no project read", async () => {
    const { verifier, scripted } = verifierFor(verifyResponder([keyRow({ projectScope: 'all' })]));
    const result = await verifier.verifyApiKey(bearer(), '203.0.113.7');
    expect(result).toEqual({
      ok: true,
      value: {
        kind: 'api_key',
        keyId: KEY,
        organizationId: ORG,
        scopes: ['docs:read'],
        projectIds: 'all',
      },
    });
    expect(scripted.statements().some(isKeyProjects)).toBe(false);
  });

  it('reads the listed projects only after the proof, and none means none', async () => {
    for (const projects of [[PROJECT_B, PROJECT_A], []]) {
      const { verifier, scripted } = verifierFor(
        verifyResponder([keyRow({ projectScope: 'listed' })], projects),
      );
      const result = await verifier.verifyApiKey(bearer(), '203.0.113.7');
      if (!result.ok) throw result.error;
      expect(result.value.projectIds).toEqual(projects);
      const [first, second] = scripted.statements();
      expect(first !== undefined && isKeyProof(first)).toBe(true);
      expect(second !== undefined && isKeyProjects(second)).toBe(true);
    }
  });

  it('writes the use time only when it is due, after the proof', async () => {
    const due = verifierFor(verifyResponder([keyRow({ useDue: true })]));
    await due.verifier.verifyApiKey(bearer(), '203.0.113.7');
    const writes = due.scripted.writes();
    expect(writes).toHaveLength(1);
    expect(writes[0] !== undefined && isUseWrite(writes[0])).toBe(true);
    expect(writes[0]?.sql).toContain('"last_used_at"');
    const fresh = verifierFor(verifyResponder([keyRow({ useDue: false })]));
    await fresh.verifier.verifyApiKey(bearer(), '203.0.113.7');
    expect(fresh.scripted.writes()).toEqual([]);
  });

  it('counts no failure for a key that proved itself', async () => {
    const { verifier, limiter } = verifierFor(verifyResponder([keyRow()]));
    const result = await verifier.verifyApiKey(bearer(), '203.0.113.7');
    expect(result.ok).toBe(true);
    expect(limiter.keys).toEqual([]);
  });

  it('refuses a stored project scope or scope it does not know as a fault', async () => {
    for (const row of [keyRow({ projectScope: 'some' }), keyRow({ scopes: ['Docs read'] })]) {
      const { verifier } = verifierFor(verifyResponder([row]));
      const result = await verifier.verifyApiKey(bearer(), '203.0.113.7');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('AUTH_UNAVAILABLE');
    }
  });
});
