import { PRODUCTS, type Product } from '@drefyn/entitlements';
import { z } from 'zod';
import { AuthError } from './errors.ts';
import { PERMISSIONS, type Permission } from './permissions.ts';

// What an API key may do: a closed list each product registers, every scope mapped to the
// organization permission a person needs to grant it.
export type Scope = `${Product}:${string}`;

export interface ScopeDefinition {
  readonly scope: string;
  readonly permission: Permission;
}

export interface ScopeRegistry {
  readonly scopes: readonly Scope[];
  // Null for anything not registered, so an unknown scope can never be granted.
  permissionFor(scope: unknown): Permission | null;
}

// A key must never mint a key, touch membership, billing or settings, or delete the
// organization, so no scope may stand for these.
export const MANAGEMENT_PERMISSIONS: readonly Permission[] = Object.freeze([
  'org.manage_members',
  'org.manage_api_keys',
  'org.manage_billing',
  'org.manage_settings',
  'org.delete',
]);

export const SCOPE_PATTERN =
  /^(docs|studio|status):[a-z][a-z0-9_]{0,30}(?:\.[a-z][a-z0-9_]{0,30})?$/;
export const MAX_SCOPES = 64;

const MANAGEMENT: ReadonlySet<Permission> = new Set(MANAGEMENT_PERMISSIONS);
const PRODUCT_SET: ReadonlySet<string> = new Set(PRODUCTS);

const DEFINITIONS = z
  .array(
    z.object({
      scope: z.string().regex(SCOPE_PATTERN),
      permission: z.enum(PERMISSIONS),
    }),
  )
  .min(1)
  .max(MAX_SCOPES);

// A product scope may stand for an organization wide permission or that product's own read,
// never another product's.
function fitsProduct(scope: string, permission: Permission): boolean {
  const product = scope.slice(0, scope.indexOf(':'));
  const [area] = permission.split('.');
  return area === product || !PRODUCT_SET.has(area ?? '');
}

export function isScopeShape(value: unknown): value is Scope {
  return typeof value === 'string' && SCOPE_PATTERN.test(value);
}

export function createScopeRegistry(definitions: readonly ScopeDefinition[]): ScopeRegistry {
  const parsed = DEFINITIONS.safeParse(definitions);
  if (!parsed.success) throw new AuthError('AUTH_CONFIG_INVALID', { cause: parsed.error });
  const map = new Map<string, Permission>();
  for (const { scope, permission } of parsed.data) {
    if (map.has(scope) || MANAGEMENT.has(permission) || !fitsProduct(scope, permission)) {
      throw new AuthError('AUTH_CONFIG_INVALID');
    }
    map.set(scope, permission);
  }
  const scopes = Object.freeze([...map.keys()] as Scope[]);
  return Object.freeze({
    scopes,
    permissionFor: (scope: unknown) =>
      typeof scope === 'string' ? (map.get(scope) ?? null) : null,
  });
}
