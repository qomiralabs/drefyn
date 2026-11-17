import { API_KEY_SCOPES } from '@drefyn/auth/permissions';
import { describe, expect, it } from 'vitest';
import { API_SCOPES, apiScopes, productOf } from '../src/scopes.ts';

describe('API scopes', () => {
  it('registers the content and docs scopes, each standing for its product read', () => {
    expect(apiScopes.scopes).toEqual([
      'studio:content.read',
      'studio:content.read_drafts',
      'studio:content.write',
      'docs:pages.read',
    ]);
    for (const scope of API_SCOPES) {
      expect(apiScopes.permissionFor(scope)).toBe(`${productOf(scope)}.read`);
    }
    expect(apiScopes.permissionFor('studio:content_read')).toBeNull();
  });

  // A key minted in the dashboard today must pass the same check when content routes ship.
  it('uses the names the dashboard grants for read and write', () => {
    const granted = new Set(API_KEY_SCOPES.map((s) => s.scope));
    expect(granted).toContain('studio:content.read');
    expect(granted).toContain('studio:content.write');
    expect(granted).toContain('docs:pages.read');
  });

  it('knows the product every scope reaches', () => {
    expect(Object.fromEntries(API_SCOPES.map((scope) => [scope, productOf(scope)]))).toEqual({
      'studio:content.read': 'studio',
      'studio:content.read_drafts': 'studio',
      'studio:content.write': 'studio',
      'docs:pages.read': 'docs',
    });
  });
});
