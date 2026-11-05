import { describe, expect, it } from 'vitest';
import {
  API_KEY_SCOPES,
  MANAGEMENT_PERMISSIONS,
  PERMISSIONS,
  createScopeRegistry,
  type Permission,
} from '../src/index.ts';
import { expectAuthError } from './support.ts';

describe('createScopeRegistry', () => {
  it('maps each registered scope to its permission and nothing else', () => {
    const registry = createScopeRegistry([
      { scope: 'docs:read', permission: 'docs.read' },
      { scope: 'status:read', permission: 'status.read' },
    ]);
    expect(registry.scopes).toEqual(['docs:read', 'status:read']);
    expect(registry.permissionFor('docs:read')).toBe('docs.read');
    expect(registry.permissionFor('docs:write')).toBeNull();
    expect(registry.permissionFor(42)).toBeNull();
    expect(registry.permissionFor('__proto__')).toBeNull();
    expect(Object.isFrozen(registry.scopes)).toBe(true);
  });

  it('refuses every management permission, so a key can never mint a key or touch members', () => {
    expect(MANAGEMENT_PERMISSIONS).toEqual([
      'org.manage_members',
      'org.manage_api_keys',
      'org.manage_billing',
      'org.manage_settings',
      'org.delete',
    ]);
    for (const permission of MANAGEMENT_PERMISSIONS) {
      expectAuthError(
        () => createScopeRegistry([{ scope: 'docs:admin', permission }]),
        'AUTH_CONFIG_INVALID',
      );
    }
  });

  it('accepts every other permission when the product matches', () => {
    const allowed = PERMISSIONS.filter((p) => !MANAGEMENT_PERMISSIONS.includes(p));
    expect(allowed).toEqual([
      'org.read',
      'project.create',
      'docs.read',
      'studio.read',
      'status.read',
    ]);
    for (const permission of ['org.read', 'project.create', 'docs.read'] as const) {
      expect(createScopeRegistry([{ scope: 'docs:x', permission }]).permissionFor('docs:x')).toBe(
        permission,
      );
    }
  });

  it.each([
    ['another product', [{ scope: 'docs:read', permission: 'status.read' }]],
    ['an unknown permission', [{ scope: 'docs:read', permission: 'docs.write' }]],
    ['an unknown product', [{ scope: 'blog:read', permission: 'org.read' }]],
    ['upper case', [{ scope: 'Docs:read', permission: 'docs.read' }]],
    ['no name', [{ scope: 'docs:', permission: 'docs.read' }]],
    ['a space', [{ scope: 'docs:re ad', permission: 'docs.read' }]],
    ['a long name', [{ scope: `docs:${'a'.repeat(64)}`, permission: 'docs.read' }]],
    [
      'a scope twice',
      [
        { scope: 'docs:read', permission: 'docs.read' },
        { scope: 'docs:read', permission: 'docs.read' },
      ],
    ],
    ['no scopes', []],
    ['a non object', [null]],
  ])('refuses %s', (_name, definitions) => {
    expectAuthError(
      () =>
        createScopeRegistry(
          definitions as unknown as readonly { scope: string; permission: Permission }[],
        ),
      'AUTH_CONFIG_INVALID',
    );
  });

  it('refuses more than 64 scopes', () => {
    const many = Array.from({ length: 65 }, (_, i) => ({
      scope: `docs:s${String(i)}`,
      permission: 'docs.read' as const,
    }));
    expectAuthError(() => createScopeRegistry(many), 'AUTH_CONFIG_INVALID');
    expect(createScopeRegistry(many.slice(0, 64)).scopes).toHaveLength(64);
  });
});

describe('the scopes the pages offer', () => {
  it('all pass the registry rules', () => {
    const registry = createScopeRegistry(
      API_KEY_SCOPES.map(({ scope, permission }) => ({ scope, permission })),
    );
    expect(registry.scopes).toHaveLength(API_KEY_SCOPES.length);
  });

  it('say which product they belong to', () => {
    for (const { scope, product } of API_KEY_SCOPES) expect(scope.split(':')[0]).toBe(product);
  });
});
