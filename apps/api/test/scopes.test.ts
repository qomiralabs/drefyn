import { API_KEY_SCOPES } from '@drefyn/auth/permissions';
import { describe, expect, it } from 'vitest';
import { API_SCOPES, apiScopes, productOf } from '../src/scopes.ts';

describe('API scopes', () => {
  it('registers the content scopes, each standing for the product read', () => {
    expect(apiScopes.scopes).toEqual([
      'studio:content.read',
      'studio:content.read_drafts',
      'studio:content.write',
    ]);
    for (const scope of API_SCOPES) expect(apiScopes.permissionFor(scope)).toBe('studio.read');
    expect(apiScopes.permissionFor('studio:content_read')).toBeNull();
  });

  // A key minted in the dashboard today must pass the same check when content routes ship.
  it('uses the names the dashboard grants for read and write', () => {
    const granted = new Set(API_KEY_SCOPES.map((s) => s.scope));
    expect(granted).toContain('studio:content.read');
    expect(granted).toContain('studio:content.write');
  });

  it('knows the product every scope reaches', () => {
    for (const scope of API_SCOPES) expect(productOf(scope)).toBe('studio');
  });
});
