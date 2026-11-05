import { describe, expect, it } from 'vitest';
import { identityRows, invitationRows, keyRows, memberRows } from '../src/server/settings-views.ts';

const AT = new Date('2026-10-31T10:00:00.000Z');
const ISO = AT.toISOString();

describe('settings view rows', () => {
  it('turns dates into strings for the client', () => {
    const list = {
      members: [
        {
          membershipId: 'm',
          name: 'Maya',
          email: 'maya@acme.dev',
          role: 'owner',
          defaultProjectRole: null,
          joinedAt: AT,
          self: true,
          projectRoles: [],
        },
      ],
      invitations: [
        {
          invitationId: 'i',
          email: 'jo@acme.dev',
          role: 'member',
          defaultProjectRole: 'viewer',
          invitedBy: 'Maya',
          expiresAt: AT,
          expired: false,
        },
      ],
    } as never;
    expect(memberRows(list)[0]?.joinedAt).toBe(ISO);
    expect(invitationRows(list)[0]?.expiresAt).toBe(ISO);
  });

  it('keeps whether a key is revoked and leaves out when', () => {
    const page = {
      items: [
        {
          keyId: 'k',
          name: 'ci',
          displaySuffix: 'ab',
          scopes: [],
          projectScope: 'all',
          projectIds: [],
          state: 'revoked',
          creatorName: null,
          createdAt: AT,
          lastUsedAt: null,
          expiresAt: AT,
          revokedAt: AT,
        },
      ],
    } as never;
    const [row] = keyRows(page);
    expect(row).toMatchObject({ state: 'revoked', lastUsedAt: null, expiresAt: ISO });
    expect(row).not.toHaveProperty('revokedAt');
    expect(JSON.stringify(row)).not.toContain('secret');
  });

  it('names a linked provider by its confirmed address', () => {
    const account = {
      identities: [{ provider: 'github', account: 'maya@acme.dev', linkedAt: AT }],
    } as never;
    expect(identityRows(account)).toEqual([
      { provider: 'github', account: 'maya@acme.dev', linkedAt: ISO },
    ]);
  });
});
